/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { countSetBits } from "./bitsutil.js";
import { MaskBottom } from "./bufreader.js";
import { dec16, chr16 } from "./b64.js";

const debug = false;

export function flagsToTags(flags) {
  // flags has to be an array of 16-bit integers.
  const header = flags[0];
  const tagIndices = [];
  const values = [];
  for (let i = 0, mask = 0x8000; i < 16; i++) {
    if (header << i === 0) break;
    if ((header & mask) === mask) {
      tagIndices.push(i);
    }
    mask = mask >>> 1;
  }
  // flags.length must be equal to tagIndices.length
  if (tagIndices.length !== flags.length - 1) {
    console.log(tagIndices, flags, "flags/header mismatch (upsert bug?)");
    return values;
  }
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i + 1];
    const index = tagIndices[i];
    for (let j = 0, mask = 0x8000; j < 16; j++) {
      if (flag << j === 0) break;
      if ((flag & mask) === mask) {
        const pos = index * 16 + j;
        if (debug) {
          console.log("pos", pos, "i/ti", index, tagIndices, "j/i", j, i);
        }
        values.push(pos);
      }
      mask = mask >>> 1;
    }
  }
  return values;
}

export function tagsToFlags(tags) {
  let res = chr16(0);

  for (const tag of tags) {
    const val = parseInt(tag);
    const header = 0;
    const index = (val / 16) | 0;
    const pos = val % 16;
    if (debug) log.d("val:", val, " tag:", tag);

    let h = dec16(res[header]);

    if (debug) {
      log.d(
        "mask:",
        MaskBottom[16][16 - index].toString(16).padStart(4, 0),
        "h start:",
        h.toString(16).padStart(4, 0),
        " countbit:",
        countSetBits(h & MaskBottom[16][16 - index])
      );
    }
    const dataIndex = countSetBits(h & MaskBottom[16][16 - index]) + 1;

    let n = ((h >>> (15 - index)) & 0x1) !== 1 ? 0 : dec16(res[dataIndex]);
    const upsertData = n !== 0;
    h |= 1 << (15 - index);
    n |= 1 << (15 - pos);

    res =
      chr16(h) +
      res.slice(1, dataIndex) +
      chr16(n) +
      res.slice(upsertData ? dataIndex + 1 : dataIndex);
    if (debug) {
      let hexres = "";
      for (const r of res) {
        hexres += dec16(r).toString(16).padStart(4, 0) + " ";
      }
      log.d(
        "h:",
        h.toString(16).padStart(4, 0),
        "r: ",
        hexres,
        " n:",
        n.toString(16).padStart(4, 0),
        " dataIndex:",
        dataIndex,
        " index:",
        index,
        " pos:",
        pos
      );
    }
  }
  if (debug) log.d(res);
  return res;
}
