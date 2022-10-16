/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
const BASE64 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export function chr16(ord) {
  return chrm(ord, false);
}

/**
 * Returns the character unit that represents the given value. If this were
 * binary data, we would simply return id.
 */
export function chrm(ord, b64) {
  return b64 ? BASE64[ord] : String.fromCharCode(ord);
}

/**
 * Returns the decimal value of the given character unit.
 */
export const ORD = {};

for (let i = 0; i < BASE64.length; i++) {
  ORD[BASE64[i]] = i;
}

export function dec16(chr) {
  return decm(chr, false);
}

export function decm(chr, b64) {
  return b64 ? ORD[chr] : chr.charCodeAt(0);
}
