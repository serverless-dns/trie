/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { W, bufferView } from "./config.js";
import { MaskTop } from "./bufreader.js";

/**
 * The BitWriter will create a stream of bytes, letting you write a certain
 * number of bits at a time. This is part of the encoder, so it is not
 * optimized for memory or speed.
 */
export function BitWriter() {
  this.init();
}

BitWriter.prototype = {
  init: function () {
    this.bits = [];
    this.bytes = [];
    this.bits16 = [];
    this.top = 0;
  },

  write16(data, numBits) {
    // todo: throw error?
    if (numBits > 16) {
      log.e("writes upto 16 lsb bits; out of range: " + numBits);
      return;
    }
    const n = data;
    const brim = 16 - (this.top % 16);
    const cur = (this.top / 16) | 0;
    const e = this.bits16[cur] | 0;
    let remainingBits = 0;
    // clear msb
    let b = n & MaskTop[16][16 - numBits];

    // shift to bit pos to be right at brim-th bit
    if (brim >= numBits) {
      b = b << (brim - numBits);
    } else {
      // shave right most bits if there are too many bits than
      // what the current element at the brim can accomodate
      remainingBits = numBits - brim;
      b = b >>> remainingBits;
    }
    // overlay b on current element, e.
    b = e | b;
    this.bits16[cur] = b;

    // account for the left-over bits shaved off by brim
    if (remainingBits > 0) {
      b = n & MaskTop[16][16 - remainingBits];
      b = b << (16 - remainingBits);
      this.bits16[cur + 1] = b;
    }

    // update top to reflect the bits included
    this.top += numBits;
  },

  /**
   * Write some data to the bit string; number(bits) <= 32.
   */
  write: function (data, numBits) {
    while (numBits > 0) {
      // take 16 and then the leftover pass it to write16
      const i = ((numBits - 1) / 16) | 0;
      const b = data >>> (i * 16);
      const l = numBits % 16 === 0 ? 16 : numBits % 16;
      this.write16(b, l);
      numBits -= l;
    }
    return;
  },

  getData: function () {
    return this.bitsToBytes();
  },

  /**
   * Get the bitstring represented as a javascript string of bytes
   */
  bitsToBytes: function () {
    return bufferView[W].from(this.bits16);
  },
};
