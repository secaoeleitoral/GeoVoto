"""Gera jogo/municipios.json (resultado de presidente 2026 + contorno simplificado de cada município)
para o jogo estilo GeoGuessr. Uso: python gerar_dados_jogo.py"""
import glob, json
import pandas as pd
from shapely.geometry import shape, mapping

TOLERANCIA = 0.004  # graus (~400 m)
TOP = 5             # candidatos guardados por município

csvs = [f for f in glob.glob("presidente_2026_*_municipios.csv")]
df = pd.concat([pd.read_csv(f, sep=";", encoding="utf-8-sig", decimal=",", dtype={"Cód. IBGE": str}) for f in csvs])
df = df[df["Destinação do voto"] == "Válido"].sort_values("Votos", ascending=False)

geo = json.load(open("presidente_2026_brasil_municipios_simplificado.geojson", encoding="utf-8"))
geometrias = {f["properties"]["cd_ibge"]: f for f in geo["features"]}

# Coordenadas da sede (centro urbano) de cada município, de github.com/kelvins/municipios-brasileiros
sedes = pd.read_csv("dados_externos/municipios_sedes.csv", dtype={"codigo_ibge": str})
sedes = {r.codigo_ibge: [round(r.longitude, 4), round(r.latitude, 4)] for r in sedes.itertuples()}

def arredondar(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 3), round(coords[1], 3)]
    return [arredondar(c) for c in coords]

municipios = []
for ibge, g in df.groupby("Cód. IBGE", sort=False):
    f = geometrias.get(ibge)
    if f is None:
        print("sem geometria:", ibge, g["Município"].iloc[0])
        continue
    forma = shape(f["geometry"]).simplify(TOLERANCIA, preserve_topology=True)
    geom = mapping(forma)
    poligonos = [geom["coordinates"]] if geom["type"] == "Polygon" else list(geom["coordinates"])
    validos = int(g["Votos"].sum())
    municipios.append({
        "id": ibge,
        "nome": f["properties"].get("nome_ibge") or g["Município"].iloc[0].title(),
        "uf": g["UF"].iloc[0],
        "validos": validos,
        "eleitorado": f["properties"].get("eleitorado"),
        "sede": sedes.get(ibge),
        "res": [[r.Candidato, r.Partido, int(r.Votos)] for r in g.head(TOP).itertuples()],
        "geo": arredondar(poligonos),
    })

with open("jogo/municipios.json", "w", encoding="utf-8") as saida:
    json.dump(municipios, saida, ensure_ascii=False, separators=(",", ":"))
print(len(municipios), "municípios gravados em jogo/municipios.json")
print("sem sede:", [m["nome"] for m in municipios if not m["sede"]])
