// GeoVoto: Street View + resultado de presidente 2026 por município.

const CORES = { "LULA": "#d6262f", "FLAVIO BOLSONARO": "#2563c9" };
const COR_OUTROS = "#8a8f99"; // "Outros somados" no modo preciso
const CORES_OUTROS =["#8e6bd8", "#e08a2c", "#2aa198", "#8a8f99", "#c0549a"];
const NOMES = {
  "LULA": "Lula",
  "FLAVIO BOLSONARO": "Flávio Bolsonaro",
  "ESCRITOR AUGUSTO CURY": "Augusto Cury",
  "ZEMA": "Romeu Zema",
};
const UFS = {
  AC: "Acre", AL: "Alagoas", AM: "Amazonas", AP: "Amapá", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MG: "Minas Gerais", MS: "Mato Grosso do Sul",
  MT: "Mato Grosso", PA: "Pará", PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", PR: "Paraná",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RO: "Rondônia", RR: "Roraima", RS: "Rio Grande do Sul",
  SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo", TO: "Tocantins",
};
// Raios (m) para achar um panorama perto do ponto sorteado
const RAIOS_BUSCA = { urbano: [150, 500, 1500], rural: [1000, 5000, 20000] };
// Chance de cada rodada cair perto da sede do município, conforme a opção "Locais"
const CHANCE_URBANO = { mais_urbanos: 0.8, urbanos: 1, misto: 0.5 };
const MAX_MUNICIPIOS_TENTADOS = 25;

const $ = (id) => document.getElementById(id);
const nomeCand = (c) => NOMES[c] || c.toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase());
const pct = (x) => x.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";

let MUNICIPIOS = [];
let corPorCand = {};
let sv, panorama, mapa, mapaFim;
const estado = {};

// ---------- Geometria ----------

function dentroAnel(x, y, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function dentroMunicipio(m, x, y) {
  return m.geo.some((pol) => dentroAnel(x, y, pol[0]) && !pol.slice(1).some((buraco) => dentroAnel(x, y, buraco)));
}

function caixa(m) {
  if (!m.caixa) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const pol of m.geo) for (const [x, y] of pol[0]) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    m.caixa = [x0, y0, x1, y1];
  }
  return m.caixa;
}

function pontoAleatorio(m) {
  const [x0, y0, x1, y1] = caixa(m);
  for (let i = 0; i < 500; i++) {
    const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
    if (dentroMunicipio(m, x, y)) return { lat: y, lng: x };
  }
  const [x, y] = m.geo[0][0][0];
  return { lat: y, lng: x };
}

// Ponto perto da sede, concentrado no centro; o raio cresce com o tamanho da cidade
// (~1 km numa cidade pequena, ~11 km em São Paulo).
function pontoUrbano(m) {
  const raioKm = 0.8 + 0.004 * Math.sqrt(m.validos);
  const r = raioKm * Math.random() ** 1.5, ang = Math.random() * 2 * Math.PI;
  const [x, y] = m.sede;
  return { lat: y + (r / 111) * Math.sin(ang), lng: x + (r / (111 * Math.cos((y * Math.PI) / 180))) * Math.cos(ang) };
}

// ---------- Dados ----------

function vencedor(m) { return m.res[0][0]; }

// Divisão real dos votos válidos em %: [candidato A, candidato B, outros somados].
function divisaoReal(m) {
  const votos = (c) => (m.res.find((r) => r[0] === c) || [0, 0, 0])[2];
  const a = (100 * votos(estado.candA)) / m.validos, b = (100 * votos(estado.candB)) / m.validos;
  return [a, b, 100 - a - b];
}

async function carregarDados() {
  const resp = await fetch("municipios.json");
  MUNICIPIOS = await resp.json();

  // Candidatos ordenados por número de municípios vencidos
  const vitorias = {};
  for (const m of MUNICIPIOS) vitorias[vencedor(m)] = (vitorias[vencedor(m)] || 0) + 1;
  const todos = {};
  for (const m of MUNICIPIOS) for (const [c] of m.res) todos[c] = true;
  let i = 0;
  for (const c of Object.keys(todos)) corPorCand[c] = CORES[c] || CORES_OUTROS[i++ % CORES_OUTROS.length];

  const contagem = {};
  for (const m of MUNICIPIOS) contagem[m.uf] = (contagem[m.uf] || 0) + 1;
  $("cfg-uf").innerHTML =
    `<option value="">Brasil inteiro (${MUNICIPIOS.length.toLocaleString("pt-BR")} municípios)</option>` +
    Object.keys(UFS).filter((uf) => contagem[uf])
      .map((uf) => `<option value="${uf}">${UFS[uf]} (${contagem[uf]})</option>`).join("");
}

// ---------- Google Maps ----------

function carregarGoogle() {
  return new Promise((ok, falha) => {
    if (typeof GOOGLE_MAPS_KEY === "undefined" || !GOOGLE_MAPS_KEY) {
      return falha(new Error("Chave não encontrada. Confira o arquivo config.js."));
    }
    window.gm_authFailure = () => mostrarAviso(
      "O Google recusou a chave. Confira se a <b>Maps JavaScript API</b> está ativada, se o faturamento está ligado " +
      `e se <code>${location.origin}/*</code> está na lista de sites permitidos da chave.`);
    window.googleCarregado = ok;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}` +
      "&v=weekly&language=pt-BR&region=BR&loading=async&callback=googleCarregado";
    s.async = true;
    s.onerror = () => falha(new Error("Não foi possível carregar o Google Maps."));
    document.head.appendChild(s);
  });
}

function criarMapa(el) {
  const m = new google.maps.Map(el, {
    mapTypeId: "terrain", disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy",
    center: { lat: -15, lng: -52 }, zoom: 4,
  });
  m.data.setStyle((f) => ({
    fillColor: f.getProperty("cor"), fillOpacity: 0.45, strokeColor: f.getProperty("borda") || f.getProperty("cor"),
    strokeWeight: 2, icon: f.getGeometry().getType() === "Point"
      ? { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#f5c542", fillOpacity: 1, strokeColor: "#111", strokeWeight: 2 }
      : undefined,
  }));
  return m;
}

function geojsonMunicipio(m, props) {
  return { type: "Feature", properties: props, geometry: { type: "MultiPolygon", coordinates: m.geo } };
}

function enquadrar(mapaAlvo, municipios) {
  const b = new google.maps.LatLngBounds();
  for (const m of municipios) {
    const [x0, y0, x1, y1] = caixa(m);
    b.extend({ lat: y0, lng: x0 }); b.extend({ lat: y1, lng: x1 });
  }
  mapaAlvo.fitBounds(b, 24);
}

// Sorteia municípios até achar um panorama do Google que caia dentro do próprio município.
async function sortearLocal() {
  const fonte = google.maps.StreetViewSource.GOOGLE
    ? { sources: [google.maps.StreetViewSource.GOOGLE] }
    : { source: google.maps.StreetViewSource.OUTDOOR };
  const tipo = Math.random() < CHANCE_URBANO[estado.locais] ? "urbano" : "rural";
  for (let t = 0; t < MAX_MUNICIPIOS_TENTADOS; t++) {
    const livres = estado.pool.filter((m) => !estado.usados.has(m.id));
    if (!livres.length) estado.usados.clear();
    const m = (livres.length ? livres : estado.pool)[Math.floor(Math.random() * (livres.length || estado.pool.length))];
    estado.usados.add(m.id);
    for (const raio of RAIOS_BUSCA[tipo]) {
      try {
        const { data } = await sv.getPanorama({
          location: tipo === "urbano" ? pontoUrbano(m) : pontoAleatorio(m), radius: raio, preference: google.maps.StreetViewPreference.NEAREST, ...fonte,
        });
        const p = data.location.latLng;
        if (dentroMunicipio(m, p.lng(), p.lat())) return { m, pano: data.location.pano, latLng: p };
      } catch { /* sem panorama nesse raio */ }
    }
  }
  return null;
}

// ---------- Fluxo do jogo ----------

function mostrarAviso(html) {
  $("aviso").innerHTML = html;
  $("aviso").hidden = false;
  $("inicio").hidden = false;
  $("carregando").hidden = true;
}

function iniciarJogo() {
  const uf = $("cfg-uf").value;
  Object.assign(estado, {
    uf, rodadas: +$("cfg-rodadas").value, modo: $("cfg-modo").value, mover: $("cfg-mover").checked,
    locais: $("cfg-locais").value, dificuldade: $("cfg-dificuldade").value,
    pool: MUNICIPIOS.filter((m) => !uf || m.uf === uf),
    usados: new Set(), rodada: 0, pontos: 0, sequencia: 0, historico: [],
  });

  // Opções de resposta: quem venceu em algum município da região (no mínimo os dois mais votados)
  const vitorias = {}, votos = {};
  for (const m of estado.pool) {
    vitorias[vencedor(m)] = (vitorias[vencedor(m)] || 0) + 1;
    for (const [c, , v] of m.res) votos[c] = (votos[c] || 0) + v;
  }
  const porVotos = Object.keys(votos).sort((a, b) => votos[b] - votos[a]);
  estado.opcoes = porVotos.filter((c, i) => vitorias[c] || i < 2);
  [estado.candA, estado.candB] = ["LULA", "FLAVIO BOLSONARO"].every((c) => votos[c]) ? ["LULA", "FLAVIO BOLSONARO"] : porVotos;

  $("opcoes").innerHTML = estado.opcoes.map((c, i) => {
    const partido = estado.pool.flatMap((m) => m.res).find((r) => r[0] === c)[1];
    return `<button class="opcao" data-cand="${c}" style="--cor:${corPorCand[c]}"><kbd>${i + 1}</kbd>${nomeCand(c)}<small>${partido}</small></button>`;
  }).join("");
  document.querySelectorAll(".opcao").forEach((b) => (b.onclick = () => responder(b.dataset.cand)));

  [estado.candA, estado.candB].forEach((c, i) => {
    $(`rot-${i}`).textContent = nomeCand(c);
    $(`rot-${i}`).style.color = corPorCand[c];
    FAIXAS[i].style.setProperty("--cor", corPorCand[c]);
  });
  FAIXAS[2].style.setProperty("--cor", COR_OUTROS);
  // No 2º turno só há dois candidatos: a barra "Outros" some
  estado.temOutros = estado.pool.some((m) => m.res.length > 2);
  FAIXAS[2].closest(".faixa-linha").hidden = !estado.temOutros;
  $("dica").textContent = estado.temOutros
    ? "O total fica sempre em 100%: ao mexer numa barra, a que você mexeu há mais tempo compensa."
    : "O total fica sempre em 100%: ao mexer numa barra, a outra se ajusta.";
  $("opcoes").hidden = estado.modo === "preciso";
  $("preciso").hidden = estado.modo !== "preciso";

  panorama.setOptions({ linksControl: estado.mover, clickToGo: estado.mover, scrollwheel: true });
  $("inicio").hidden = $("fim").hidden = true;
  $("barra").hidden = false;
  proximaRodada();
}

async function proximaRodada(pular = false) {
  if (!pular) estado.rodada++;
  $("resultado").hidden = $("palpite").hidden = true;
  $("carregando").hidden = false;
  atualizarPlacar();

  const local = await sortearLocal();
  $("carregando").hidden = true;
  if (!local) return mostrarAviso("Não encontrei Street View nessa região depois de várias tentativas. Tente outra região.");

  estado.atual = { ...local, respondida: false };
  panorama.setPano(local.pano);
  panorama.setPov({ heading: Math.random() * 360, pitch: 0 });
  panorama.setZoom(0);
  panorama.setVisible(true);
  reiniciarFaixas();
  $("local-nome").innerHTML = `📍 ${local.m.nome} <small>${UFS[local.m.uf] || local.m.uf}</small>`;
  $("local-nome").hidden = estado.dificuldade !== "facil";
  $("palpite").hidden = false;
}

function atualizarPlacar() {
  $("rodada").textContent = `${estado.rodada}/${estado.rodadas}`;
  $("pontos").textContent = estado.pontos.toLocaleString("pt-BR");
  $("sequencia").textContent = estado.sequencia;
}

// Palpite do modo preciso em %: [candidato A, candidato B, outros], com uma casa decimal.
// As contas são feitas em décimos (0–1000) para a soma fechar exatamente em 100%.
const FAIXAS = [0, 1, 2].map((i) => $(`faixa-${i}`));
const CAMPOS = [0, 1, 2].map((i) => $(`val-${i}`));
const decimos = () => FAIXAS.map((f) => Math.round(+f.value * 10));
const palpiteAtual = () => decimos().map((d) => d / 10);
const fmt1 = (x) => x.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function definirPalpite(dec) {
  dec.forEach((d, i) => {
    FAIXAS[i].value = d / 10;
    FAIXAS[i].style.setProperty("--v", `${d / 10}%`);
    // Não reescreve o campo enquanto a pessoa está digitando nele
    if (document.activeElement !== CAMPOS[i]) CAMPOS[i].value = fmt1(d / 10);
  });
}

// Ordem em que as barras foram mexidas (a mais antiga primeiro). Ao mexer uma barra, a mexida há
// mais tempo compensa a diferença para o total continuar em 100%; se ela chegar a 0, a outra completa.
let ordemMexidas = [0, 1, 2];
function mexerFaixa(i, valor) {
  ordemMexidas = [...ordemMexidas.filter((x) => x !== i), i];
  const v = decimos();
  if (valor !== undefined) v[i] = Math.round(Math.min(100, Math.max(0, valor)) * 10);
  let sobra = 1000 - v[0] - v[1] - v[2];
  for (const j of ordemMexidas.filter((x) => x !== i && (x !== 2 || estado.temOutros))) {
    const novo = Math.min(1000, Math.max(0, v[j] + sobra));
    sobra -= novo - v[j];
    v[j] = novo;
  }
  definirPalpite(v);
}

function reiniciarFaixas() {
  ordemMexidas = [0, 1, 2];
  definirPalpite(estado.temOutros ? [470, 470, 60] : [500, 500, 0]);
}

function responder(escolha) {
  const atual = estado.atual;
  if (!atual || atual.respondida) return;
  atual.respondida = true;
  const m = atual.m, real = vencedor(m);
  let pontos, acertou, textoPalpite;

  if (estado.modo === "preciso") {
    const palpite = palpiteAtual(), verdade = divisaoReal(m);
    // Erro = porcentagem de votos que estaria no lugar errado (soma das diferenças ÷ 2)
    const erro = palpite.reduce((s, p, i) => s + Math.abs(p - verdade[i]), 0) / 2;
    pontos = Math.round(1000 * Math.exp(-erro / 10));
    acertou = Math.sign(palpite[0] - palpite[1]) === Math.sign(verdade[0] - verdade[1]) || erro < 2;
    const linhas = [estado.candA, estado.candB, "OUTROS"].map((c, i) =>
      c === "OUTROS" && !estado.temOutros ? "" :
      `<tr><td><i style="background:${corPorCand[c] || COR_OUTROS}"></i>${c === "OUTROS" ? "Outros" : nomeCand(c)}</td>` +
      `<td>${fmt1(palpite[i])}%</td><td>${pct(verdade[i])}</td></tr>`).join("");
    textoPalpite = `<table class="comparacao"><tr><th></th><th>Seu palpite</th><th>Real</th></tr>${linhas}</table>` +
      `Erro de ${pct(erro).replace("%", " p.p.")}`;
  } else {
    acertou = escolha === real;
    pontos = acertou ? 1000 : 0;
    textoPalpite = `Seu palpite: ${nomeCand(escolha)}`;
  }

  estado.pontos += pontos;
  estado.sequencia = acertou ? estado.sequencia + 1 : 0;
  estado.historico.push({ m, acertou, pontos });
  atualizarPlacar();
  mostrarResultado(m, acertou, pontos, textoPalpite);
}

function mostrarResultado(m, acertou, pontos, textoPalpite) {
  $("palpite").hidden = true;
  $("res-cabecalho").innerHTML =
    `<span class="${acertou ? "certo" : "errado"}">${acertou ? "✓ Acertou!" : "✗ Errou"}</span><span class="pts">+${pontos} pts</span>`;
  $("res-cidade").innerHTML = `${m.nome} <small>${UFS[m.uf] || m.uf}</small>`;
  $("res-palpite").innerHTML = textoPalpite;
  $("res-barras").innerHTML = m.res.map(([c, partido, v], i) => {
    const p = (100 * v) / m.validos;
    return `<div class="barra-cand ${i === 0 ? "vencedor" : ""}" style="--cor:${corPorCand[c]}">
      <div class="linha"><span>${nomeCand(c)} <small>(${partido})</small></span><span>${pct(p)}</span></div>
      <div class="trilho"><div class="cheio" style="width:${p}%"></div></div></div>`;
  }).join("") +
    `<p class="sub">${m.validos.toLocaleString("pt-BR")} votos válidos</p>`;

  const ultima = estado.rodada >= estado.rodadas;
  $("btn-proxima").textContent = ultima ? "Ver resultado final" : "Próxima rodada";
  $("resultado").hidden = false;

  if (!mapa) mapa = criarMapa($("mapa"));
  mapa.data.forEach((f) => mapa.data.remove(f));
  mapa.data.addGeoJson(geojsonMunicipio(m, { cor: corPorCand[vencedor(m)] }));
  mapa.data.add({ geometry: estado.atual.latLng });
  enquadrar(mapa, [m]);
}

function fimDeJogo() {
  $("resultado").hidden = $("palpite").hidden = $("barra").hidden = true;
  const max = estado.rodadas * 1000, acertos = estado.historico.filter((h) => h.acertou).length;
  $("fim-total").innerHTML =
    `<b>${estado.pontos.toLocaleString("pt-BR")}</b> de ${max.toLocaleString("pt-BR")} pontos · ` +
    `${acertos} de ${estado.rodadas} vencedores certos`;
  $("fim-lista").innerHTML = estado.historico.map(({ m, acertou, pontos }) =>
    `<li><span class="${acertou ? "ok" : "nao"}">${acertou ? "✓" : "✗"}</span> ${m.nome} – ${m.uf}
     <span>· ${nomeCand(vencedor(m))} ${pct((100 * m.res[0][2]) / m.validos)} · +${pontos}</span></li>`).join("");
  $("fim").hidden = false;

  if (!mapaFim) mapaFim = criarMapa($("mapa-fim"));
  mapaFim.data.forEach((f) => mapaFim.data.remove(f));
  for (const h of estado.historico) {
    mapaFim.data.addGeoJson(geojsonMunicipio(h.m, {
      cor: corPorCand[vencedor(h.m)], borda: h.acertou ? "#2fb36b" : "#e0523f",
    }));
  }
  enquadrar(mapaFim, estado.historico.map((h) => h.m));
}

// ---------- Inicialização ----------

$("btn-jogar").onclick = iniciarJogo;
$("btn-novo").onclick = () => { $("fim").hidden = true; $("inicio").hidden = false; };
$("btn-proxima").onclick = () => (estado.rodada >= estado.rodadas ? fimDeJogo() : proximaRodada());
$("btn-pular").onclick = () => estado.atual && !estado.atual.respondida && proximaRodada(true);
$("btn-inicio").onclick = () => estado.atual && panorama.setPano(estado.atual.pano);
$("btn-confirmar").onclick = () => responder();
FAIXAS.forEach((f, i) => (f.oninput = () => mexerFaixa(i)));
CAMPOS.forEach((campo, i) => {
  campo.oninput = () => {
    const x = parseFloat(campo.value.replace(",", "."));
    if (!isNaN(x)) mexerFaixa(i, x);
  };
  // Ao sair do campo, mostra o valor já ajustado (ex.: "58,33" vira "58,3")
  campo.onchange = () => (campo.value = fmt1(palpiteAtual()[i]));
  campo.onfocus = () => campo.select();
});

document.addEventListener("keydown", (e) => {
  const campoPalpite = CAMPOS.includes(e.target); // Enter nos campos de % confirma o palpite
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT" && e.target.type !== "range" && !campoPalpite) return;
  if (!$("palpite").hidden && estado.modo === "classico" && /^[1-9]$/.test(e.key)) {
    const c = estado.opcoes[+e.key - 1];
    if (c) responder(c);
  } else if (!$("palpite").hidden && estado.modo === "preciso" && e.key === "Enter") {
    responder();
  } else if (!$("resultado").hidden && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    $("btn-proxima").click();
  }
});

Promise.all([carregarDados(), carregarGoogle()])
  .then(() => {
    sv = new google.maps.StreetViewService();
    panorama = new google.maps.StreetViewPanorama($("streetview"), {
      addressControl: false, showRoadLabels: false, fullscreenControl: false, motionTracking: false,
      motionTrackingControl: false, enableCloseButton: false, imageDateControl: false, visible: false,
    });
    $("btn-jogar").disabled = false;
    $("btn-jogar").textContent = "Jogar";
  })
  .catch((erro) => mostrarAviso(erro.message));
