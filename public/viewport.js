// Selección temprana de vista sin JavaScript inline, para que la CSP pueda bloquearlo.
if (innerWidth / innerHeight > 2.3 && !new URLSearchParams(location.search).has('classic')) {
  location.replace(`msd.html${location.search}`);
}
