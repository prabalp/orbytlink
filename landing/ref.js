// Tells the app which page a visitor came from, so a signup can be traced to the post or page that
// led to it. It adds ?lp=<this page's path> to every link to app.orbytlink.com, plus the referring
// site and any utm_ tags this page was opened with. It stores nothing and sends nothing by itself.
(function () {
  var here = new URLSearchParams(location.search);
  var q = new URLSearchParams();
  q.set("lp", (location.pathname.replace(/index\.html$/, "").replace(/\.html$/, "") || "/").slice(0, 120));
  ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
    var v = here.get(k);
    if (v) q.set(k, v.slice(0, 80));
  });
  try {
    var r = new URL(document.referrer);
    if (r.hostname && r.hostname !== location.hostname) q.set("ref", r.hostname.slice(0, 100));
  } catch (e) {
    // no referrer
  }
  // For the signup form on the home page, which builds its own link to the app.
  window.olQuery = function () {
    return "?" + q.toString();
  };
  document.querySelectorAll('a[href^="https://app.orbytlink.com"]').forEach(function (a) {
    var u = new URL(a.href);
    q.forEach(function (v, k) {
      if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    });
    a.href = u.toString();
  });
})();
