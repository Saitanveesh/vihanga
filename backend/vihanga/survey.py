"""Geospatial survey lane generator.

Preview only. Coordinates and bounded geometry are real; results are never
transmitted to aircraft. No airspace, terrain, obstacle or geofence clearance.
"""
from __future__ import annotations

from math import asin, atan2, cos, pi, radians, sin, sqrt
from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

R = 6_371_000.0
router = APIRouter(prefix="/api/v1")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Position(StrictModel):
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)


class SurveyRequest(StrictModel):
    polygon: list[Position] = Field(min_length=3, max_length=80)
    spacing_m: float = Field(ge=5, le=200, allow_inf_nan=False)
    angle_deg: float = Field(ge=0, lt=180, allow_inf_nan=False)
    altitude_m: float = Field(ge=10, le=120, allow_inf_nan=False)
    speed_mps: float = Field(default=5.0, ge=0.5, le=25, allow_inf_nan=False)


def route_length(points: list[dict]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        latitude_a, latitude_b = radians(a["latitude"]), radians(b["latitude"])
        longitude_delta = radians(b["longitude"] - a["longitude"])
        delta = latitude_b - latitude_a
        h = sin(delta / 2) ** 2 + cos(latitude_a) * cos(latitude_b) * sin(longitude_delta / 2) ** 2
        total += 2 * R * asin(min(1.0, sqrt(h)))
    return round(total, 2)


def _cross(a: tuple, b: tuple, c: tuple) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _intersects(a: tuple, b: tuple, c: tuple, d: tuple) -> bool:
    p, q = _cross(a, b, c), _cross(a, b, d)
    r, s = _cross(c, d, a), _cross(c, d, b)
    return ((p > 1e-6 and q < -1e-6) or (p < -1e-6 and q > 1e-6)) and (
        (r > 1e-6 and s < -1e-6) or (r < -1e-6 and s > 1e-6)
    )


def compute_survey(request: SurveyRequest) -> dict:
    original = [(p.latitude, p.longitude) for p in request.polygon]
    if original[0] == original[-1]:
        original.pop()
    if len(original) < 3:
        raise ValueError("Polygon requires at least three distinct vertices")
    if len(set(original)) != len(original):
        raise ValueError("Polygon has repeated vertices")
    lat0 = sum(p[0] for p in original) / len(original)
    lon0 = sum(p[1] for p in original) / len(original)
    if abs(lat0) >= 85 or max(x[1] for x in original) - min(x[1] for x in original) > 0.1:
        raise ValueError("Unsupported polar or antimeridian-crossing survey")
    scale_x = R * cos(radians(lat0)) * radians(1)
    scale_y = R * radians(1)
    polygon = [((lon - lon0) * scale_x, (lat - lat0) * scale_y) for lat, lon in original]
    if max(x for x, _ in polygon) - min(x for x, _ in polygon) > 5000 or (
        max(y for _, y in polygon) - min(y for _, y in polygon) > 5000
    ):
        raise ValueError("Survey extent exceeds the 5 km planning limit")
    n = len(polygon)
    for i in range(n):
        a, b = polygon[i], polygon[(i + 1) % n]
        if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 0.01:
            raise ValueError("Adjacent survey vertices are too close")
        for j in range(i + 1, n):
            if j in (i, (i + 1) % n) or i == (j + 1) % n:
                continue
            if _intersects(a, b, polygon[j], polygon[(j + 1) % n]):
                raise ValueError("Survey polygon intersects itself")
    signed_area = sum(polygon[i][0] * polygon[(i + 1) % n][1] -
                      polygon[(i + 1) % n][0] * polygon[i][1] for i in range(n)) / 2
    area = abs(signed_area)
    if not 25 <= area <= 10_000_000:
        raise ValueError("Survey area must be between 25 m² and 10 km²")

    # Rotate into along-track u, perpendicular v. 0 degrees runs north-south.
    a = radians(request.angle_deg)
    direction = (sin(a), cos(a))
    transverse = (cos(a), -sin(a))
    local = [(x * direction[0] + y * direction[1],
              x * transverse[0] + y * transverse[1]) for x, y in polygon]
    low, high = min(t for _, t in local), max(t for _, t in local)
    lines = []
    t = low + request.spacing_m / 2
    if t > high:
        t = (low + high) / 2
    index = 0
    while t < high + 1e-7:
        intersects = []
        for i in range(n):
            s1, t1 = local[i]
            s2, t2 = local[(i + 1) % n]
            # Half-open interval eliminates double counts at vertices.
            if (t1 <= t < t2) or (t2 <= t < t1):
                intersects.append(s1 + (t - t1) * (s2 - s1) / (t2 - t1))
        intersects.sort()
        if len(intersects) % 2:
            raise ValueError("Survey polygon crossing calculation failed")
        for j in range(0, len(intersects), 2):
            if intersects[j + 1] - intersects[j] > 1.0:
                p1, p2 = (intersects[j], t), (intersects[j + 1], t)
                if index % 2:
                    p1, p2 = p2, p1
                lines.append((p1, p2))
                index += 1
                if index > 100:
                    raise ValueError("Too many survey lanes; increase line spacing")
        t += request.spacing_m
    if not lines:
        raise ValueError("No survey lanes fit the selected polygon and spacing")

    def point(p: tuple) -> dict:
        s, t = p
        x = s * direction[0] + t * transverse[0]
        y = s * direction[1] + t * transverse[1]
        return {
            "latitude": round(lat0 + y / scale_y, 8),
            "longitude": round(lon0 + x / scale_x, 8),
            "altitude_m": request.altitude_m,
        }

    waypoints = [point(p) for line in lines for p in line]
    # Connecting lane endpoints may cross outside the survey polygon.
    # This geometry is a draft only; never claim the transit is a safe corridor.
    return {
        "waypoints": waypoints, "lane_count": len(lines),
        "area_m2": round(area, 1), "route_distance_m": route_length(waypoints),
        "polygon": [p.model_dump() for p in request.polygon],
        "estimated_duration_s": round(route_length(waypoints) / request.speed_mps, 1),
        "requires_route_review": True,
        "status": "PREVIEW_ONLY",
    }


@router.post("/surveys/preview")
def survey_preview(request: SurveyRequest):
    try:
        return compute_survey(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class CircularSurveyRequest(StrictModel):
    """A conservative polygon-inscribed circular survey preview.

    Designed for convex polygons. It excludes nonconvex boundaries rather than
    generate routes through excluded ground; terrain and turning margins still
    require pilot review.
    """
    polygon: list[Position] = Field(min_length=3, max_length=30)
    spacing_m: float = Field(ge=5, le=200, allow_inf_nan=False)
    altitude_m: float = Field(ge=10, le=120, allow_inf_nan=False)
    speed_mps: float = Field(default=5.0, ge=0.5, le=25, allow_inf_nan=False)


def compute_circular(request: CircularSurveyRequest) -> dict:
    pts = [(p.latitude, p.longitude) for p in request.polygon]
    if len(set(pts)) != len(pts):
        raise ValueError("Repeated or identical polygon vertices")
    lat0 = sum(p[0] for p in pts) / len(pts)
    lon0 = sum(p[1] for p in pts) / len(pts)
    if abs(lat0) >= 85 or max(p[1] for p in pts) - min(p[1] for p in pts) > 0.1:
        raise ValueError("Unsupported survey extent")
    sx = R * cos(radians(lat0)) * radians(1)
    sy = R * radians(1)
    poly = [((lon-lon0)*sx, (lat-lat0)*sy) for lat, lon in pts]
    if max(x for x, _ in poly) - min(x for x, _ in poly) > 5000 or max(y for _, y in poly)-min(y for _, y in poly)>5000:
        raise ValueError("Survey exceeds 5km local planning bounds")
    n = len(poly)
    cross = [_cross(poly[i],poly[(i+1)%n],poly[(i+2)%n]) for i in range(n)]
    if not (all(x > 0.000001 for x in cross) or all(x < -0.000001 for x in cross)):
        raise ValueError("Circular survey requires a strictly convex polygon")
    # The arithmetic vertex centroid is inside a strictly convex polygon.
    center_x = sum(x for x, _ in poly)/n
    center_y = sum(y for _, y in poly)/n
    distances = []
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i+1)%n]
        length = sqrt((bx-ax)**2 + (by-ay)**2)
        if length < 0.1:
            raise ValueError("Polygon edge too small")
        distances.append(abs((bx-ax)*(center_y-ay) - (by-ay)*(center_x-ax)) / length)
    radius = min(distances) - 1.0   # keep a 1m visual buffer from polygon edge
    if radius < request.spacing_m * 0.6:
        raise ValueError("Survey polygon too small for selected circular spacing")
    radii = []
    current = request.spacing_m * 0.6
    while current <= radius:
        radii.append(current)
        current += request.spacing_m
    if len(radii) > 8:
        raise ValueError("Too many circular rings; increase spacing")
    # Sample ring geometry, alternating direction to reduce unnecessary transfer.
    points = []
    per_ring = 24
    for index, r in enumerate(radii):
        count = per_ring + 1
        for j in range(count):
            t = 2*pi*j/per_ring
            if index % 2: t = -t
            x = center_x + r*cos(t)
            y = center_y + r*sin(t)
            points.append({
                "latitude": round(lat0+y/sy,8),
                "longitude": round(lon0+x/sx,8),
                "altitude_m": request.altitude_m
            })
    if len(points) > 200:
        raise ValueError("Circular route exceeds 200 points")
    length = route_length(points)
    return {
        "waypoints": points, "lane_count": len(radii),
        "area_m2": round(pi * radius * radius, 1),
        "route_distance_m": length,
        "estimated_duration_s": round(length / request.speed_mps, 1),
        "polygon": [p.model_dump() for p in request.polygon],
        "requires_route_review": True,
        "status": "PREVIEW_ONLY", "pattern": "CIRCULAR",
        "coverage_note": "Inscribed concentric loops only; polygon corners are not covered"
    }


@router.post("/surveys/circular/preview")
def circular_preview(request: CircularSurveyRequest):
    try:
        return compute_circular(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
