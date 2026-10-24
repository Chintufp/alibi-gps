/* Alibi - Wi-Fi names as witnesses.
   A web page can't scan for Wi-Fi, but you can: your phone's Wi-Fi list shows the networks around you even
   with GPS off, and shops, cafés, libraries and campuses often name theirs after the place. Wi-Fi only
   reaches about 100 m, so "I can see Lidl's Wi-Fi" puts you near a Lidl: one of them, if there are several.
   This is not how phones do Wi-Fi positioning (they look up each router's hardware address in Google's or
   Apple's closed databases); it only needs the name and the open map. */
Alibi.wifi = (function () {
  'use strict';

  // words that say nothing about the place
  const STOP = new Set(('wifi wi fi wlan wireless guest guests gast gäst free open public hotspot internet net network ' +
    'vieras vierailija vierasverkko asiakas asiakkaat asiakasverkko langaton customer customers visitor visitors ' +
    'staff 2g 5g 24g 24ghz 5ghz ghz ext the and ja och ap ssid wpa secure plus').split(' '));

  // words many places share: only searched for when nothing more telling is in the name
  const GENERIC = new Set(('cafe café kahvila coffee ravintola restaurant bar pub hotel hotelli hostel library kirjasto ' +
    'shop kauppa market store koulu school office toimisto city center centre keskus').split(' '));

  // names that move with you (trains, buses, ferries, planes, phone hotspots): they say nothing about where you are
  const MOVING = /^(vr\b|vr[-_ ]?(free|wifi|wlan|net)|onnibus|matkahuolto|hsl|nysse|föli|foli|finnair|norwegian|sas[-_ ]|viking|tallink|silja|eckerö|eckero|finnlines|flixbus|.*\b(iphone|android|galaxy|pixel|redmi|xiaomi|oneplus)\b|androidap|direct-)/i;
  // a home router's factory name, which no map knows
  const HOME = /^(dna-|telia-|elisa|huawei-|tp-?link|zyxel|netgear|asus|linksys|fritz|sagemcom|technicolor|mokkula|4g-|5g-|mifi|wlan[-_]?[0-9a-f]{3,}$|[0-9a-f]{6,}$)/i;

  // "K-Citymarket_Guest" -> ['k', 'citymarket']; "LidlFreeWiFi" -> ['lidl']
  function words(s) {
    return String(s).replace(/([a-zäöå])([A-ZÄÖÅ])/g, '$1 $2')
      .toLowerCase().normalize('NFC').split(/[^0-9a-zäöåüéè]+/).filter((t) => t && !STOP.has(t));
  }
  const flat = (s) => String(s).toLowerCase().replace(/[^0-9a-zäöåüéè]+/g, '');

  // What kind of name is it? { kind: 'place' | 'campus' | 'moving' | 'home' | 'empty', key, tokens }
  function parse(ssid) {
    const name = String(ssid || '').trim();
    if (!name) return { kind: 'empty' };
    if (/^eduroam$/i.test(name)) return { kind: 'campus', key: 'eduroam', tokens: [] };
    if (MOVING.test(name)) return { kind: 'moving' };
    if (HOME.test(name)) return { kind: 'home' };
    const tokens = words(name);
    const strong = tokens.filter((t) => t.length >= 3);
    const use = strong.length ? strong : tokens.length === 1 ? tokens : [];
    if (!use.length) return { kind: 'empty' };
    // search the map for the most telling word (not a generic one, then the longest); places whose name
    // has more of the words are preferred afterwards
    const key = use.slice().sort((a, b) => (GENERIC.has(a) - GENERIC.has(b)) || (b.length - a.length))[0];
    return { kind: 'place', key, tokens: use };
  }

  // Overpass regular expression for a word: ignore case, ä/a and å/a, ö/o, and punctuation between letters
  // (so "mcdonalds" finds "McDonald's" and "kcitymarket" finds "K-Citymarket")
  const ALT = { a: '(a|ä|å)', ä: '(a|ä)', å: '(a|å)', o: '(o|ö)', ö: '(o|ö)', u: '(u|ü)', e: '(e|é|è)' };
  function pattern(word) {
    return [...word].map((c) => ALT[c] || c.replace(/[^0-9a-z]/g, '.')).join("[-'’.&_ ]?");
  }

  // How many words of the Wi-Fi name does a mapped place's name have?
  const plain = (s) => s.replace(/[äå]/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/[éè]/g, 'e');
  function fits(tags, tokens) {
    const names = [tags.name, tags.brand, tags['internet_access:ssid'], tags['name:en'], tags['name:fi'], tags.operator]
      .filter(Boolean).map((n) => plain(flat(n)));
    return Math.max(0, ...names.map((n) => tokens.filter((t) => n.includes(plain(t))).length));
  }

  return { parse, pattern, fits, words };
})();
