/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as os from "node:os";
import * as process from "node:process";

// a simple logger that prints time on every output
const E = "E/";
const W = "W/";
const I = "I/";
const D = "D/";

export function d(...args) {
  console.debug(t(), D, ...args);
}

export function i(...args) {
  console.info(t(), I, ...args);
}

export function w(...args) {
  console.warn(t(), W, ...args);
}

export function e(...args) {
  console.error(t(), E, ...args);
}

export function t() {
  return new Date().toISOString();
}

export function sys(extra = false) {
  const btomb = 1000 * 1000;
  const kbtomb = 1000;
  const utosec = 1000 * 1000;
  if (extra) {
    // os info
    const loadavg = os.loadavg().map((avg) => avg / btomb);
    const freemem = os.freemem() / btomb;
    const totalmem = os.totalmem() / btomb;
    i(
      "<osinfo>",
      "| cpu-avg",
      loadavg,
      "| mem-free",
      freemem,
      "| mem-use",
      totalmem
    );
  }

  // Deno doesn't yet impl process.memoryUsage and
  // process.resourceUsage: std@0.159.0/node/process.ts
  if (typeof Deno !== "undefined") return;

  // memory info
  const meminfo = process.memoryUsage(); // is slow
  const rss = meminfo.rss / btomb;
  const totalheap = meminfo.heapTotal / btomb;
  const usedheap = meminfo.heapUsed / btomb;
  const ext = meminfo.external / btomb;
  const buf = meminfo.arrayBuffers / btomb;
  i(
    "<meminfo>",
    "| rss",
    rss,
    "| heap-total",
    totalheap,
    "| heap-used",
    usedheap,
    "| external",
    ext,
    "| buffers",
    buf
  );
  if (extra) {
    // proc info
    const procinfo = process.resourceUsage();
    const userslice = procinfo.userCPUTime / utosec;
    const systemslice = procinfo.systemCPUTime / utosec;
    const maxrss = procinfo.maxRSS / kbtomb;
    const minorpf = procinfo.minorPageFault;
    const majorpf = procinfo.majorPageFault;
    i(
      "<procinfo>",
      "| user",
      userslice,
      "| system",
      systemslice,
      "| maxrss",
      maxrss,
      "| minor",
      minorpf,
      "| major",
      majorpf
    );
  }
}
