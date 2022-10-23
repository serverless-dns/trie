/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Number of bits (width) of each encoding unit; ie 6 => base64.
 */
export const W = 16;

export const bufferView = { 15: Uint16Array, 16: Uint16Array, 6: Uint8Array };

/**
 * Fixed values for the L1 and L2 table sizes in the Rank Directory
 */
export const L1 = 32 * 32;
export const L2 = 32;

export const config = {
  // inspect trie building stats
  inspect: false,
  // debug prints debug logs
  debug: false,
  // transforms select ops into rank ops with help of a modified l1/l2 layer
  selectsearch: true,
  // use codec type b6 to convert js-str to bytes and vice-versa
  useCodec6: true,
  // optimize storing flags, that is, store less than 3 flags as-is
  optflags: true,
};
