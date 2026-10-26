"""Places the nightly activity forecast is made for: the 14 study boxes plus fill-ins. A fill-in borrows the
"typical night" cut-offs of the nearest study box (its weather climate is close, and no extra history is downloaded)."""
import math

from .regions import REGIONS

EXTRA = {
    "la_crosse": (43.8, -91.2), "rochester_mn": (44.0, -92.5), "duluth": (46.8, -92.1), "st_cloud": (45.5, -94.2),
    "cedar_rapids": (42.0, -91.7), "davenport": (41.5, -90.6), "rockford": (42.3, -89.1), "peoria": (40.7, -89.6),
    "champaign": (40.1, -88.2), "fort_wayne": (41.1, -85.1), "south_bend": (41.7, -86.3), "lansing": (42.7, -84.5),
    "toledo": (41.65, -83.55), "dayton": (39.8, -84.2), "marquette": (46.5, -87.4), "traverse_city": (44.75, -85.6),
    "evansville": (38.0, -87.55), "terre_haute": (39.5, -87.4), "springfield_il": (39.8, -89.65),
    "youngstown": (41.1, -80.9), "waterloo_ia": (42.5, -92.3), "eau_claire": (44.8, -91.5), "wausau": (44.95, -89.6),
    "sioux_city": (42.5, -96.4),
}
ANCHORS = {**REGIONS, **EXTRA}


def nearest_region(lat, lng, among=None):
    k = math.cos(math.radians(lat))
    return min(among or REGIONS, key=lambda r: (REGIONS[r][0] - lat) ** 2 + ((REGIONS[r][1] - lng) * k) ** 2)
