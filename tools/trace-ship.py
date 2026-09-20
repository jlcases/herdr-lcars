#!/usr/bin/env python3
"""Regenera public/ship.json y las texturas de tinta a partir de las láminas de la patente de diseño US D307,923
(Andrew Probert, 1990). La patente de diseño ha expirado; otros derechos de terceros no se
relicencian. Véase NOTICE.md. Requiere opencv-python, numpy y pillow.

  python3 tools/trace-ship.py

Perfil lateral: lámina 2 (FIG. 2), recorte fijo, rotado 90° horario y reflejado para dejar la proa a la izquierda y el
dorso arriba. Planta: lámina 1 (FIG. 1), rotada 90° antihorario. La silueta sólida se obtiene rellenando el fondo desde
los bordes; el hueco entre góndola, pilón y casco (región cerrada por líneas) se elimina por su etiqueta de componente.
Las zonas (platillo, cuello, casco, góndola) se derivan de las regiones blancas del dibujo.
"""
import json, pathlib
import cv2, numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / 'public'

def prep(path, bbox, rot):
    g = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE); x0, y0, x1, y1 = bbox
    crop = g[y0:y1, x0:x1]
    if rot == 'cw-mirror': crop = cv2.flip(cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE), 1)
    if rot == 'ccw': crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    dark = (crop < 140).astype(np.uint8)
    lines = cv2.dilate(dark, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    white = (1 - lines).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
    outside = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    solid = np.ones_like(lines)
    for i in outside: solid[lab == i] = 0
    return crop, dark, lab, st, solid

def largest(mask):
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8)); k = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]); return (lab == k).astype(np.uint8)

def contours(mask, eps=1.6, minarea=1500):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnts = [c for c in cnts if cv2.contourArea(c) > minarea]
    return [cv2.approxPolyDP(c, eps, True).reshape(-1, 2).tolist() for c in sorted(cnts, key=cv2.contourArea, reverse=True)]

def ink_png(dark, solid, name, color=(204, 153, 204)):
    ink = (dark & solid).astype(np.uint8); H, W = ink.shape
    rgba = np.zeros((H, W, 4), np.uint8); rgba[..., :3] = color; rgba[..., 3] = ink * 255
    Image.fromarray(rgba, 'RGBA').save(name)

def region_at(lab, x, y): return int(lab[y, x])

# ---- perfil ----
crop, dark, lab, st, solid = prep(HERE / 'patent-D307923-sheet2-side.png', (983, 352, 1576, 3022), 'cw-mirror')
# regiones identificadas por un punto interior (coordenadas del recorte rotado 2670×593)
# centros de las regiones blancas del dibujo (medidos una vez sobre el recorte rotado)
def region_at_checked(x, y, what, win=25):
    # etiqueta blanca predominante en una ventana alrededor del punto (evita caer en una línea de trama)
    patch = lab[max(0, y - win):y + win, max(0, x - win):x + win].ravel()
    patch = patch[patch != 0]
    assert patch.size, f'ventana vacía para {what} en ({x},{y})'
    ids, counts = np.unique(patch, return_counts=True)
    r = int(ids[np.argmax(counts)])
    assert st[r, cv2.CC_STAT_AREA] > 1000, f'región demasiado pequeña para {what} en ({x},{y})'
    return r
gap = region_at_checked(2029, 380, 'hueco góndola/casco'); neck_id = region_at_checked(1495, 290, 'cuello')
hull_ids = {region_at_checked(1802, 414, 'casco sup'), region_at_checked(1762, 520, 'casco inf'), region_at_checked(2363, 427, 'casco popa')}
nac_ids = {region_at_checked(2296, 254, 'góndola sup'), region_at_checked(2296, 314, 'góndola inf'), region_at_checked(1702, 287, 'bussard')}
solid[lab == gap] = 0; solid = largest(solid)
def zone(ids, close=31):
    m = np.zeros_like(solid)
    for i in ids: m[lab == i] = 1
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close)))
    return (m & solid).astype(np.uint8)
neck = zone([neck_id]); nacelle = zone(nac_ids, 41); hull = (zone(hull_ids, 41) & (1 - nacelle)).astype(np.uint8)
saucer = largest(solid & (1 - neck) & (1 - hull) & (1 - nacelle))
H, W = solid.shape
side = {'w': W, 'h': H, 'outline': contours(solid)[0], 'zones': {'saucer': contours(saucer), 'neck': contours(neck), 'hull': contours(hull), 'nacelle': contours(nacelle)}}
ink_png(dark, solid, OUT / 'ship-side-ink.png')

# ---- planta ----
crop2, dark2, lab2, st2, solid2 = prep(HERE / 'patent-D307923-sheet1-top.png', (293, 374, 2082, 2818), 'ccw')
solid2 = largest(solid2); H2, W2 = solid2.shape
rings = []; m = solid2.copy()
for i in range(6):
    m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    cs = contours(m, eps=2.5)
    if not cs: break
    rings.append(cs)
top = {'w': W2, 'h': H2, 'outline': contours(solid2)[0], 'rings': rings}
ink_png(dark2, solid2, OUT / 'ship-top-ink.png')
json.dump({'side': side, 'top': top}, open(OUT / 'ship.json', 'w'))
vis = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
for k, col in [('saucer', (255, 180, 0)), ('neck', (0, 200, 0)), ('hull', (0, 160, 255)), ('nacelle', (200, 0, 200))]:
    for poly in side['zones'][k]: cv2.polylines(vis, [np.array(poly).reshape(-1, 1, 2)], True, col, 3)
cv2.imwrite(str(HERE / 'trace-check.png'), vis)
print('ok', W, H, {k: [len(p) for p in v] for k, v in side['zones'].items()}, 'top', W2, H2, len(rings), 'rings')
