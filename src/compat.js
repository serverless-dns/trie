/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const zerostr = "";

// maps new subg and pack to legacy subg
const legacysubg = new Map();

// from: github.com/serverless-dns/blocklists/commit/721a15c6cc
// in.subg(mixedcase) -> out.subg(lowercase-or-hypens)
legacysubg.set("BypassMethods", "bypass-methods");
legacysubg.set("SafeSearch", "safesearch");
legacysubg.set("Piracy", "piracy");
legacysubg.set("Porn", "porn");
legacysubg.set("Services", "services");
legacysubg.set("Cryptojacking", "cryptojacking");
legacysubg.set("ThreatIntelligence", "thread-intelligence-feeds");
legacysubg.set("TrackingDomains", "tracking-domains");
legacysubg.set("Native", "native");

// in.pack -> out.subg
legacysubg.set("vpn & proxies", "bypass-methods");
legacysubg.set("dating", "dating");
legacysubg.set("gambling", "gambling");
legacysubg.set("adult", "porn");
legacysubg.set("socialmedia", "social-networks");
legacysubg.set("crypto", "crypojacking");
legacysubg.set("malware", "threat-intelligence-feeds");
legacysubg.set("scams & phishing", "threat-intelligence-feeds");
legacysubg.set("spam", "threat-intelligence-feeds");
legacysubg.set("recommended", "rethinkdns-recommended");
legacysubg.set("amazon", "native");
legacysubg.set("tiktok", "services");
legacysubg.set("facebook", "services");
legacysubg.set("drugs", "threat-intelligence-feeds");
legacysubg.set("piracy", "piracy");
legacysubg.set("url-shorteners", "tracking-domains");
legacysubg.set("google", "services");

// in.subg(blocklist names) -> out.subg(empty)
legacysubg.set("Olbat", zerostr);
legacysubg.set("Sinfonietta", zerostr);
legacysubg.set("BaddBoyz", zerostr);
legacysubg.set("EasyList", zerostr);
legacysubg.set("Hagezi", zerostr);
legacysubg.set("Energized", zerostr);
legacysubg.set("Fanboy", zerostr);
legacysubg.set("GoodbyeAds", zerostr);
legacysubg.set("Lighswitch05", zerostr);
legacysubg.set("StevenBlack", zerostr);
legacysubg.set("Tiuxo", zerostr);
legacysubg.set("CPBL", zerostr);
legacysubg.set("OISD", zerostr);
legacysubg.set("1Hosts", zerostr);
legacysubg.set("The Block List Project", zerostr);
legacysubg.set("RPiList", zerostr);
legacysubg.set("Amnesty", zerostr);

// in.pack(niche/new) -> out.subg(empty)
legacysubg.set("liteprivacy", zerostr);
legacysubg.set("aggressiveprivacy", zerostr);
legacysubg.set("extremeprivacy", zerostr);
legacysubg.set("spyware", zerostr);
legacysubg.set("smart-tv", zerostr);
legacysubg.set("streams", zerostr);
legacysubg.set("torrents", zerostr);

function legacySubg(entry) {
  if (entry.subg) {
    const subg0 = entry.subg;
    const preferred0 = legacysubg.get(subg0);
    if (preferred0) return preferred0;
    const subg1 = entry.subg.toLowerCase();
    const preferred1 = legacysubg.get(subg1);
    if (preferred1) return preferred1;
  }

  for (const p of entry.pack) {
    const preferred = legacysubg.get(p);
    if (preferred) return preferred;
  }

  return zerostr;
}

function isStr(s) {
  return typeof s === "string" || s instanceof String;
}

export function unlegacy(ft) {
  const tags = Object.assign({}, ft);
  // id may be a string or string(number), ex: "MTF" or "101"
  for (let [id, entry] of Object.entries(tags)) {
    // may be a str or a list, but normalize it to a list
    if (isStr(entry.url)) {
      // convert to list
      entry.url = [entry.url];
    }
    // if id is not entry.value; then make it so
    // eslint-disable-next-line eqeqeq
    if (entry.value != id) {
      // stackoverflow.com/a/50101979
      // add property against key entry.value
      // and remove property against key id
      delete tags[id];
      id = entry.value;
    }
    const o = { [id]: entry };
    Object.assign(tags, o);
  }
  return tags;
}

export function legacy(ft) {
  // initLegacy();
  const tags = Object.assign({}, ft);
  for (const [id, entry] of Object.entries(tags)) {
    // may be a str or a list, but normalize it to a str
    if (!isStr(entry.url)) {
      // if it's a list, just take the first str element
      entry.url = entry.url[0];
    }
    entry.group = entry.group.toLowerCase();
    entry.subg = legacySubg(entry);
    const o = { [id]: entry };
    Object.assign(tags, o);
  }
  return tags;
}

// maps the new values to the deprecated unames
export function legacyNames(bcfg) {
  const unames = {};
  for (const [u, entry] of Object.entries(bcfg)) {
    unames[entry.value] = u;
  }
  return unames;
}
