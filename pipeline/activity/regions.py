"""The study set: 14 metro boxes (about 1.2 deg x 1.6 deg), the years, and the insect groups."""
YEARS = list(range(2017, 2026))
START, END = "04-01", "10-31"

# name: (lat, lng) box centre
REGIONS = {
    "chicago": (41.85, -87.9), "milwaukee": (43.05, -88.0), "madison": (43.07, -89.4),
    "green_bay": (44.5, -88.0), "twin_cities": (44.95, -93.3), "des_moines": (41.6, -93.6),
    "kansas_city": (39.1, -94.6), "st_louis": (38.65, -90.3), "detroit": (42.4, -83.2),
    "grand_rapids": (42.9, -85.7), "indianapolis": (39.8, -86.15), "columbus": (39.95, -83.0),
    "cleveland": (41.5, -81.7), "cincinnati": (39.1, -84.5),
}
HALF_LAT, HALF_LNG = 0.6, 0.8


def box(name):
    lat, lng = REGIONS[name]
    return dict(nelat=lat + HALF_LAT, swlat=lat - HALF_LAT, nelng=lng + HALF_LNG, swlng=lng - HALF_LNG)


# iNat taxon ids. moths = Lepidoptera minus butterflies (Papilionoidea), same split as the luna fit's effort background.
LEPIDOPTERA, BUTTERFLIES, FIREFLIES = 47157, 47224, 47731
