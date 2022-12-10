/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { bitsSetTable256, countSetBits } from "./bitsutil.js";
import { W } from "./config.js";
import { dec } from "./b64.js";

const debug = false;

/**
 * Given a string of data (eg, in BASE-64), the BitString class supports
 * reading or counting a number of bits from an arbitrary position in the
 * string.
 */
export function BitString(str) {
  this.init(str);
}

export const MaskTop = {
  16: [
    0xffff, 0x7fff, 0x3fff, 0x1fff, 0x0fff, 0x07ff, 0x03ff, 0x01ff, 0x00ff,
    0x007f, 0x003f, 0x001f, 0x000f, 0x0007, 0x0003, 0x0001, 0x0000,
  ],
};

export const MaskBottom = {
  16: [
    0xffff, 0xfffe, 0xfffc, 0xfff8, 0xfff0, 0xffe0, 0xffc0, 0xff80, 0xff00,
    0xfe00, 0xfc00, 0xf800, 0xf000, 0xe000, 0xc000, 0x8000, 0x0000,
  ],
};

BitString.prototype = {
  init: function (str) {
    this.bytes = str;
    this.length = this.bytes.length * W;
    // trie#flag/value-node uses binary-string, ref: trie#levelorder
    this.binaryString = typeof str === "string";
  },

  /**
   * Returns the internal string of bytes
   */
  getData: function () {
    return this.bytes;
  },

  /**
   * Return an array of decimal values, one for every n bits.
   */
  encode: function (n) {
    const e = [];
    for (let i = 0; i < this.length; i += n) {
      if (!this.binaryString) {
        e.push(this.get(i, Math.min(this.length, n)));
      } else {
        e.push(this.get2(i, Math.min(this.length, n)));
      }
    }
    return e;
  },

  /**
   * Returns a decimal number, consisting of n bits starting at position p
   * in a uint16, this.bytes.
   */
  get: function (p, n) {
    // supports n <= 31, since js bitwise operations work only on +ve ints

    // case 1: bits lie within the given byte
    if ((p % W) + n <= W) {
      return (this.bytes[(p / W) | 0] & MaskTop[W][p % W]) >> (W - (p % W) - n);
    } else {
      // case 2: bits lie incompletely in the given byte
      let result = this.bytes[(p / W) | 0] & MaskTop[W][p % W];

      const l = W - (p % W);
      p += l;
      n -= l;

      while (n >= W) {
        result = (result << W) | this.bytes[(p / W) | 0];
        p += W;
        n -= W;
      }
      if (n > 0) {
        result = (result << n) | (this.bytes[(p / W) | 0] >> (W - n));
      }

      return result;
    }
  },

  /**
   * Returns a decimal number consisting of n bits starting at position p
   * in a binary-string, this.bytes
   */
  get2: function (p, n) {
    // case 1: bits lie within the given byte
    if ((p % W) + n <= W) {
      return (
        (dec(this.bytes[(p / W) | 0], W) & MaskTop[W][p % W]) >>
        (W - (p % W) - n)
      );
    } else {
      // case 2: bits lie incompletely in the given byte
      let result = dec(this.bytes[(p / W) | 0], W) & MaskTop[W][p % W];

      const l = W - (p % W);
      p += l;
      n -= l;

      while (n >= W) {
        result = (result << W) | dec(this.bytes[(p / W) | 0], W);
        p += W;
        n -= W;
      }

      if (n > 0) {
        result = (result << n) | (dec(this.bytes[(p / W) | 0], W) >> (W - n));
      }

      return result;
    }
  },

  /**
   * Counts the number of bits set to 1 starting at position p and
   * ending at position p + n
   */
  count: function (p, n) {
    let count = 0;
    while (n >= 16) {
      count += bitsSetTable256[this.get(p, 16)];
      p += 16;
      n -= 16;
    }

    return count + bitsSetTable256[this.get(p, n)];
  },

  /**
   * Returns the index of the nth 0, starting at position i.
   */
  pos0: function (i, n) {
    if (n < 0) return 0;
    if (n === 0) return i;
    let step = 16;
    let index = i;
    // do not expect more than maxiter to answer pos0
    const maxiter = this.length / 10;
    let iter = 0;

    while (n > 0) {
      if (i > this.length) {
        throw new Error("pos0: out of bounds: " + i + " len: " + this.length);
      }
      if (iter > maxiter) {
        throw new Error("pos0: out of iter: " + iter + " i: " + i);
      }
      const d = this.get(i, step);
      const bits0 = step - countSetBits(d);
      if (debug) {
        console.log(i, ":i|step:", step, "get:", this.get(i, step), "n:", n);
      }

      if (n - bits0 < 0) {
        step = Math.max(n, (step / 2) | 0);
        continue;
      }
      n -= bits0;
      i += step;
      iter += step;
      const diff = n === 0 ? bit0(d, 1, step) : 1;
      index = i - diff; // 1;
    }

    return index;
  },

  /**
   * Returns the number of bits set to 1 up to and including position x.
   * This is the slow implementation used for testing.
   */
  rank: function (x) {
    let rank = 0;
    for (let i = 0; i <= x; i++) {
      if (this.get(i, 1)) {
        rank++;
      }
    }

    return rank;
  },
};

function bit0(n, p, pad) {
  const r = bit0p(n, p);
  if (r.scanned <= 0) return r.scanned; // r.index
  if (r.index > 0) return r.scanned; // r.index
  // FIXME: The following should instead be (also see #bit0p)
  // if (pad <= r.index) return r.index
  // else error("p-th zero-bit lies is outside of pad+n")
  // The line below works because p is only ever equal to 1
  if (pad > r.scanned) return r.scanned + 1;
  else return 0;
}

/**
 * Find the pth zero bit in the number, n.
 * @param {*} n The number, which is usually unsigned 32-bits
 * @param {*} p The pth zero bit
 */
function bit0p(n, p) {
  // capture m for debug purposes
  const m = n;

  // 0th zero-bit doesn't exist (nb: valid index begins at 1)
  if (p === 0) return { index: 0, scanned: 0 };
  // when n = 0, 1st zero-bit is at index 1
  if (n === 0 && p === 1) return { index: 1, scanned: 1 };
  let c = 0;
  let i = 0;
  // iterate until either n is 0 or we've counted 'p' zero-bits
  while (n > 0 && p > c) {
    // increment c when n-th lsb-bit is 0
    c = c + (n < (n ^ 0x1)) ? 1 : 0;
    // total bits in 'n' scanned thus far
    i += 1;
    // next lsb-bit in 'n'
    n = n >>> 1;
  }
  if (debug) {
    console.log(String.fromCharCode(m).charCodeAt(0).toString(2), m, i, p, c);
  }
  // if 'p' zero-bits are accounted for, then 'i' is the p-th zero-bit in 'n'
  // FIXME: instead return: { index: i + (p - c), scanned: i }? see: #bit0
  return { index: p === c ? i : 0, scanned: i };
}
