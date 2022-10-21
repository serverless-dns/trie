/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
export const bitsSetTable256 = [];

initialize();

// Initialise the lookup table
function initialize() {
  bitsSetTable256[0] = 0;
  for (let i = 0; i < 256; i++) {
    bitsSetTable256[i] = (i & 1) + bitsSetTable256[Math.floor(i / 2)];
  }
}

// Returns the count of set bits in n
export function countSetBits(n) {
  return (
    bitsSetTable256[n & 0xff] +
    bitsSetTable256[(n >>> 8) & 0xff] +
    bitsSetTable256[(n >>> 16) & 0xff] +
    bitsSetTable256[n >>> 24]
  );
}
