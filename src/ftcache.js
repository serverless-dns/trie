/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { RangeLfu } from "@serverless-dns/lfu-cache";
import * as log from "./log.js";

export class FrozenTrieCache {
  constructor(size) {
    const name = "FrozenTrieCache";
    this.cache = new RangeLfu(name, size);
    log.i("ftcache setup with size:", size);
  }

  get(n) {
    try {
      return this.cache.get(n);
    } catch (e) {
      log.e("get", n, e.stack);
    }
    return false;
  }

  put(lo, hi, val) {
    if (hi < lo || val == null) {
      log.w(val, "put not allowed hi < lo:", hi, "<", lo);
      return;
    }
    try {
      const frequency = Math.log2((hi - lo) ** 2) | 0;
      this.cache.put(lo, hi, val, frequency);
    } catch (e) {
      log.e("put", lo, hi, val, e.stack);
    }
  }

  find(n, cursor = null) {
    try {
      // returns {value: v, cursor: c}
      return this.cache.find(n, cursor);
    } catch (e) {
      log.e("find", n, cursor, e.stack);
    }
    return false;
  }
}
