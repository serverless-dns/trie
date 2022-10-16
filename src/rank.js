/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { config } from "./config.js";
import { BitString } from "./bufreader.js";

/**
 * The rank directory allows you to build an index to quickly compute the
 * rank() and select() functions. The index can itself be encoded as a binary
 * string.
 */
export function RankDirectory(directoryData, bitData, numBits, l1Size, l2Size) {
  this.init(directoryData, bitData, numBits, l1Size, l2Size);
}

RankDirectory.prototype = {
  init: function (directoryData, trieData, numBits, l1Size, l2Size) {
    this.directory = new BitString(directoryData);
    this.data = new BitString(trieData);
    this.l1Size = l1Size;
    this.l2Size = l2Size;
    this.l1Bits = Math.ceil(Math.log2(numBits));
    this.l2Bits = Math.ceil(Math.log2(l1Size));
    this.sectionBits = (l1Size / l2Size - 1) * this.l2Bits + this.l1Bits;
    this.numBits = numBits;
  },

  /**
   * Returns the string representation of the directory.
   */
  getData: function () {
    return this.directory.getData();
  },

  /**
   * Returns the number of 1 or 0 bits (depending on the "which" parameter) to
   * to and including position x.
   */
  rank: function (which, x) {
    // fixme: selectsearch doesn't work when which === 1, throw error?
    // or, impl a proper O(1) select instead of the current gross hack.
    if (config.selectsearch) {
      let rank = -1;
      let sectionPos = 0;
      if (x >= this.l2Size) {
        sectionPos = ((x / this.l2Size) | 0) * this.l1Bits;
        rank = this.directory.get(sectionPos - this.l1Bits, this.l1Bits);
        x = x % this.l2Size;
      }
      const ans = x > 0 ? this.data.pos0(rank + 1, x) : rank;
      if (config.debug) {
        console.log("ans:", ans, rank, ":r, x:", x, "s:", sectionPos);
      }
      return ans;
    }

    if (which === 0) {
      return x - this.rank(1, x) + 1;
    }

    let rank = 0;
    let o = x;
    let sectionPos = 0;

    if (o >= this.l1Size) {
      sectionPos = ((o / this.l1Size) | 0) * this.sectionBits;
      rank = this.directory.get(sectionPos - this.l1Bits, this.l1Bits);
      if (config.debug) {
        console.log("o: " + rank + " sec: " + sectionPos);
      }
      o = o % this.l1Size;
    }

    if (o >= this.l2Size) {
      sectionPos += ((o / this.l2Size) | 0) * this.l2Bits;
      rank += this.directory.get(sectionPos - this.l2Bits, this.l2Bits);
      if (config.debug) {
        console.log("o2: " + rank + " sec: " + sectionPos);
      }
    }

    rank += this.data.count(x - (x % this.l2Size), (x % this.l2Size) + 1);

    if (config.debug) {
      console.log("ans:", rank, "x:", o, "s:", sectionPos, "o:", x);
    }

    return rank;
  },

  /**
   * Returns the position of the y'th 0 or 1 bit, depending on the "which"
   * parameter.
   */
  select: function (which, y) {
    let high = this.numBits;
    let low = -1;
    let val = -1;

    // todo: assert y less than numBits
    if (config.selectsearch) {
      return this.rank(0, y);
    }

    while (high - low > 1) {
      const probe = ((high + low) / 2) | 0;
      const r = this.rank(which, probe);

      if (r === y) {
        // We have to continue searching after we have found it,
        // because we want the _first_ occurrence.
        val = probe;
        high = probe;
      } else if (r < y) {
        low = probe;
      } else {
        high = probe;
      }
    }

    return val;
  },
};