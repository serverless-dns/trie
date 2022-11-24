/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as log from "./log.js";
import * as codec from "./codec.js";
import * as fs from "fs";
import { createHash } from "crypto";
import { createRankDirectory } from "./rank.js";
import { FrozenTrie } from "./ftrie.js";
import { BitString, MaskBottom } from "./bufreader.js";
import { BitWriter } from "./bufwriter.js";
import { countSetBits } from "./bitsutil.js";
import { dec16, chr16 } from "./b64.js";
import { flagsToTags } from "./stamp.js";
import { L1, L2, withDefaults } from "./config.js";
import * as compat from "./compat.js";

// impl based on S Hanov's succinct-trie: stevehanov.ca/blog/?id=120

/**
 * A Trie node, for building the encoding trie. Not needed for the decoder.
 */
function TrieNode(letter) {
  this.letter = letter;
  // see: upsertFlag and config.optflags
  // TODO: remove the need for optletter
  this.optletter = null;
  this.final = false;
  this.children = [];
  this.compressed = false;
  this.flag = false;
}

TrieNode.prototype = {
  scale: function (trie) {
    // capture size and len before scaling down this node
    this.size = trie.childrenSize(this);
    this.len = this.children.length;
    this.letter = this.letter[this.letter.length - 1];
    this.children.length = 0;
    this.children = undefined;
    this.optletter = null;
  },
};

// FIXME: eliminate trienode2, handle children being undefined with trienode1
function TrieNode2(letter) {
  this.letter = letter;
  this.compressed = false;
  this.final = false;
  this.children = undefined;
  this.flag = undefined;

  this.scale = function () {
    // no-op
  };
}

function Trie(c) {
  this.init(c);
}

Trie.prototype = {
  init: function (cfg) {
    this.previousWord = "";
    this.root = new TrieNode([-1]); // any letter would do nicely
    this.cache = [this.root];
    this.nodeCount = 1;
    this.stats = {};
    this.inspect = {};

    const codecType = cfg.useCodec6 ? codec.b6 : codec.b8;
    this.config = cfg;

    this.proto = new codec.Codec(codecType);
    // utf8 encoded delim for non-base32/64
    this.encodedDelim = this.proto.delimEncoded();
  },

  /**
   * Returns the number of nodes in the trie
   */
  getNodeCount: function () {
    return this.nodeCount;
  },

  // returns the "size" of the trie node in number of bytes.
  childrenSize(tn) {
    let size = 0;

    if (!tn.children) return size;

    for (const c of tn.children) {
      // each letter in c.letter is 1 byte long
      let len = c.letter.length;
      if (c.flag) {
        // nodecount depends on how flag node is encoded:
        // calc length(flag-nodes) bit-string (16bits / char)
        // ie, a single letter of a flag node is either 2 bytes
        // long (longer length flags) or 1 byte (shorter length)
        // and these bytes are either represented as in groups
        // of 8bits or 6bits (depending on proto.typ) in a uint8
        if (this.config.optflags && c.optletter != null) {
          const optlen = c.optletter.length;
          len = Math.ceil((optlen * 8) / this.proto.typ);
        } else {
          len = Math.ceil((len * 16) / this.proto.typ);
        }
      }
      size += len;
    }
    return size;
  },

  // must be kept in-sync with transform in ftrie.js
  transform(str) {
    return this.proto.encode(str).reverse();
  },

  getFlagNodeIfExists(children) {
    if (children && children.length > 0) {
      const flagNode = children[0];
      if (flagNode.flag === true) return flagNode;
    }
    return null;
  },

  /*
   * Each blocklist gets assigned an ordinal value. That is, they're assigned
   * a integer value, starting from 0. These assigned values are immutable,
   * and never change for a given version.
   *
   * These integer values are then used to encode a user's preference in a
   * (two-level) bit-map. The URL stamp max.rethinkdns.com/1:APD_______8A_A
   * is a base64 of that bit-map (1: is the version; that is, version 1).
   *
   * So, consider blocklists: BA, BB, BC, BD, BE, BF, BG, BH
   *
   * Let's assign ordinal values:
   * BA -> 0
   * BB -> 1
   * BC -> 2
   * ....
   * BG -> 6
   * BH -> 7
   *
   * One can represent all possible grouping (combinations) of these
   * blocklists in a (one-level) bit-map of size 8, that is, with 8 bits.
   *
   * (The following is an example of a big-eindian one-level bit-map)
   * 1000 0000 => means BA (at 0) was selected.
   * 0010 1000 => means BC (at 3) and BE (at 5) were selected.
   * 1111 1110 => means every list except BH (at 7) were selected.
   *
   * A two-level bit-map is an optimization.
   *
   * The first-level determines a selected blocklist group (Gx) while
   * the second-level determines the actual blocklist (Bx).
   *
   * For ex, in the above example, let me divide the blocklists into
   * two equal groups:
   *   G1              G2
   *  BA 0            BE 0
   *  BB 1            BF 1
   *  BC 2            BG 2
   *  BD 3            BH 3
   *
   * where,
   * G1 is 0
   * G2 is 1
   *
   * So now,
   * The first-level of the bit-map denotes a group: G1 or G2, or both. And
   * the second-level selects a blocklist within that group. We need 2 bits
   * to represent all combinations of groups, G1 and G2.
   *
   * We need 4 bits for blocklists in each group:
   *
   * 10 0001 => means, in G1, select BD (at 3)
   * 11 0010 1100 => means, in G1 select BC (at 2),
   * and in G2 select BE (at 0) and BF (at 1).
   * 01 0001 => means, in G2 select BH (at 3).
   *
   * The first two-bits denote the groups, following them, each group of
   * 4 bits denote the blocklists in those groups.
   *
   * The advantage with a two-level bit-map is, if a user doesn't select
   * any blocklist within a group, I only need one bit to denote that.
   * This is important as RethinkDNS has upwards of 170 blocklists to
   * support, but a user is unlikely to select most of those.
   *
   * One can do better than this, of course. The reason we chose a two-level
   * bit-map was because it allows for fast Set operations (intersection,
   * union, difference) in O(1).
   *
   * One of the simpler ways to avoid this complication of using a bit-map is
   * to simply use one of the available integer compression libraries and use
   * it to compress integer representation of a user's blocklist selection.
   *
   * A better technique for version 2 perhapse but that may never come to
   * pass: dreamsongs.com/RiseOfWorseIsBetter.html
   */
  upsertFlag: function (node, encodedFlag) {
    let newlyAdded = false;
    const first = node.children[0];
    const isNodeFlag = first && first.flag;

    if (!encodedFlag || encodedFlag.length === 0) {
      // nothing to do, since there's no flag-node to remove
      if (!isNodeFlag) return;
      // flag-node is present, so slice it out
      node.children = node.children.slice(1);
      node.flag = false;
      // bitslen / encoding type affects nodecount; depending
      // which a flag node is 8bits or 6bits long. see level order
      if (this.config.optflags && first.optletter != null) {
        this.nodeCount -= Math.ceil(
          (first.optletter.length * 8) / this.proto.typ
        );
      } else {
        this.nodeCount -= Math.ceil(
          (first.letter.length * 16) / this.proto.typ
        );
      }
      return;
    }

    const flag = this.proto.decode(encodedFlag);
    const val = flag;
    if (val == null) {
      log.w(flag, encodedFlag, "<- flags, val undef for node", node);
      throw new Error("val undefined err");
    }

    // TODO: move this bit to stamp.js?
    const flagNode = isNodeFlag ? first : new TrieNode(chr16(0));
    // if flag-node doesn't exist, add it at index 0
    if (!isNodeFlag) {
      flagNode.flag = true;
      const all = node.children;
      node.children = [flagNode]; // index 0
      node.children.concat(all);
      if (this.config.optflags) flagNode.optletter = [val];
      newlyAdded = true;
    }

    const fnode = flagNode;
    let res = fnode.letter;
    let fopt = fnode.optletter;

    const resnodesize = !newlyAdded
      ? Math.ceil((res.length * 16) / this.proto.typ)
      : 0;
    const optnodesize =
      !newlyAdded && fopt ? Math.ceil((fopt.length * 8) / this.proto.typ) : 0;

    if (!newlyAdded && this.config.optflags && fopt != null) {
      // maintain upto 3 flags as-is, if more, then wipe 'em out
      if (fopt.length < 3) {
        flagNode.optletter.push(val);
      } else {
        flagNode.optletter = null;
        fopt = null;
      }
    }

    const header = 0;
    const index = (val / 16) | 0;
    const pos = val % 16;

    let h = dec16(res[header]);
    // Fetch the actual tail index position in the character string from the
    // compressed information stored in the header.
    const dataIndex = countSetBits(h & MaskBottom[16][16 - index]) + 1;

    if (
      this.config.debug &&
      (typeof res === "undefined" || typeof res[dataIndex] === "undefined")
    ) {
      log.d(
        "res/index/h/val/pos/dataindex",
        res,
        res[dataIndex],
        h,
        val,
        pos,
        dataIndex,
        "fnode/node/flag/let",
        fnode,
        node,
        node.flag,
        node.letter
      );
    }

    // set n to either existing value or create a 0'd string
    let n = -1;
    try {
      n = ((h >>> (15 - index)) & 0x1) !== 1 ? 0 : dec16(res[dataIndex]);
    } catch (e) {
      log.e(
        "res/len/index/h/val/pos/dataindex",
        res,
        res.length,
        res[dataIndex],
        h,
        val,
        pos,
        dataIndex,
        "fnode/node/flag/let",
        fnode,
        node,
        node.flag,
        node.letter
      );
      throw e;
    }

    const upsertData = n !== 0;
    h |= 1 << (15 - index);
    n |= 1 << (15 - pos);

    res =
      chr16(h) +
      res.slice(1, dataIndex) +
      chr16(n) +
      res.slice(upsertData ? dataIndex + 1 : dataIndex);

    // this size is dependent on how the flag node is eventually
    // serialized by proto, and so calculate its size accordingly
    const newresnodesize = Math.ceil((res.length * 16) / this.proto.typ);
    const newoptnodesize = fopt
      ? Math.ceil((fopt.length * 8) / this.proto.typ)
      : 0;

    if (this.config.optflags && fopt != null) {
      this.nodeCount += newoptnodesize - optnodesize;
    } else {
      if (optnodesize > 0) {
        this.nodeCount += newresnodesize - optnodesize;
      } else {
        this.nodeCount += newresnodesize - resnodesize;
      }
    }

    fnode.letter = res;

    if (this.config.debug) log.d(flag, val, index, pos);
  },

  /**
   * Inserts a word into the trie, call in alphabetical (lexographical) order.
   */
  insert: function (word) {
    const index = word.lastIndexOf(this.encodedDelim[0]);
    if (index <= 0) {
      err =
        "missing delim in word: " +
        this.proto.decode(word) +
        ", delim: " +
        this.encodedDelim[0] +
        ", encoded: " +
        word;
      throw new Error(err);
    }
    const encodedFlag = word.slice(index + 1);
    // each letter in word must be 8bits or less.
    // todo: proto word here?
    word = word.slice(0, index);

    let j = 1;
    let k = 0;
    let p = 0;
    let topped = false;
    while (p < word.length && j < this.cache.length) {
      const cw = this.cache[j];
      let l = 0;
      while (p < word.length && l < cw.letter.length) {
        if (word[p] !== cw.letter[l]) {
          // todo: replace with break label?
          topped = true;
          break;
        }
        p += 1;
        l += 1;
      }
      k = l > 0 ? l : k;
      j = l > 0 ? j + 1 : j;
      if (topped) break;
    }

    const w = word.slice(p);
    const pos = j - 1;
    const node = this.cache[pos];
    const letter = node.letter.slice(0, k);

    // splice out everything but root
    if (pos >= 0) {
      this.cache.splice(pos + 1);
    }

    // todo: should we worry about node-type valueNode/flagNode?
    if (letter.length > 0 && letter.length !== node.letter.length) {
      const split = node.letter.slice(letter.length);
      const tn = new TrieNode(split);
      tn.final = node.final;
      // should this line exist in valueNode mode?
      tn.flag = node.flag;
      // assigning children should take care of moving the valueNode/flagNode
      tn.children = node.children;
      // do not: this.nodeCount += 1;
      node.letter = letter;
      node.children = [];
      node.children.push(tn);
      node.final = false;
      this.upsertFlag(node, undefined);
      if (this.config.debug) {
        log.d(
          "split the node newnode/currentnode/split-reason",
          n,
          node.letter,
          w
        );
      }
    }

    if (w.length === 0) {
      node.final = true;
      this.upsertFlag(node, encodedFlag);
      if (this.config.debug) {
        log.d(
          "existing node final nl/split-word/letter-match/pfx/in-word",
          node.letter,
          w,
          letter,
          commonPrefix,
          word
        );
      }
    } else {
      if (typeof node === "undefined") {
        log.d(
          "second add new-node/in-word/match-letter/parent-node",
          w,
          word,
          letter,
          searchPos
        );
      }
      const second = new TrieNode(w);
      second.final = true;
      this.upsertFlag(second, encodedFlag);
      this.nodeCount += w.length;
      node.children.push(second);
      this.cache.push(second);
    }

    // fixme: remove this, not used, may be an incorrect location to set it
    this.previousWord = word;

    return;
  },

  levelorder: function () {
    const loginspect = true;
    const verbose = false;
    const level = [this.root];
    let p = 0;
    let q = 0;
    const ord = [];
    const inspect = {};
    const flstat = [];

    for (let n = 0; n < level.length; n++) {
      const node = level[n];

      // skip processing flag-nodes in the regular loop,
      // they always are processed in conjuction with the
      // corresponding final-node. todo: not really req
      // since child-len of a flag-node is unapologetically 0.
      if (node.flag === true) continue;
      // todo: skip aux nodes

      // a node may not have children, but may have a flagNode / valueNode
      // which is always at index 0 of the node.children array
      const childrenLength = node.children ? node.children.length : 0;

      q += childrenLength;
      if (n === p) {
        ord.push(q);
        p = q;
      }

      let start = 0;
      let flen = 0;
      const flagNode = this.getFlagNodeIfExists(node.children);
      // convert flagNode / valueNode to trie children nodes
      if (flagNode) {
        start = 1;
        // fixme: abort if flag-node has no value stored?
        if (
          typeof flagNode.letter === "undefined" ||
          typeof flagNode === "undefined"
        ) {
          log.w("flagnode letter undef", flagNode, "node", node);
        }

        // encode flagNode.letter which is a 16-bit js-str
        // encode splits letter into units of 6or8bits (uint)
        let encValue = null;
        if (this.config.optflags && flagNode.optletter != null) {
          if (loginspect) inspect["optletter"] = (inspect["optletter"] | 0) + 1;
          encValue = this.proto.encode8(flagNode.optletter);
        } else {
          const letter = flagNode.letter;
          if (this.config.useCodec6) {
            encValue = this.proto.encode16(letter);
          } else {
            encValue = new BitString(letter).encode(this.proto.typ);
          }
        }

        flen = encValue.length;
        for (let i = 0; i < encValue.length; i++) {
          const l = encValue[i];
          const aux = new TrieNode2(l);
          aux.flag = true;
          level.push(aux);
        }

        if (loginspect && flen > 0) {
          // count nodes having "flen" no. of children
          const k1 = "encf_" + flen;
          inspect[k1] = (inspect[k1] | 0) + 1;
          let flags = [];
          if (this.config.optflags && flagNode.optletter != null) {
            flagNode.optletter.forEach((i) => flags.push(i));
          } else {
            const v = this.config.useCodec6
              ? this.proto.decode16raw(encValue)
              : codec.str2buf(flagNode.letter);
            flags = flagsToTags(v, /* throw-on-err*/ true);
          }
          // accumulate the count of number of blocklists
          // that appear together
          for (let f of flags) {
            f += "";
            for (let g of flags) {
              g += "";
              if (flstat[f] == null) flstat[f] = [];
              flstat[f][g] = (flstat[f][g] | 0) + 1;
            }
          }
          const k2 = "ll_" + flags.length;
          inspect[k2] = (inspect[k2] | 0) + 1;
        }
      }

      // start iterating after flagNode / valudeNode index, if any
      for (let i = start; i < childrenLength; i++) {
        const current = node.children[i];
        // flatten out: one letter each into its own trie-node except
        // the last-letter which holds reference to its children
        for (let j = 0; j < current.letter.length - 1; j++) {
          const l = current.letter[j];
          const aux = new TrieNode2(l);
          aux.compressed = true;
          level.push(aux);
        }
        // current node represents the last letter
        level.push(current);
      }
      // scale down things trie.encode doesn't need
      node.scale(this);
    }
    if (loginspect) log.d("inspect level-order", inspect);
    if (loginspect && verbose) log.d("inspect flags dist", flstat);
    return { level: level, div: ord };
  },

  /**
   * Encode the trie and all of its nodes in a bit-string.
   */
  encode: function () {
    // b00 -> !final, !compressed, !valueNode
    // b01 -> *final, !compressed, !valueNode
    // b10 -> !final, *compressed, !valueNode
    // b11 -> !final, !compressed, *valueNode
    // the above truth table is so because a single node
    // cannot be both compressed and final, at the same time.
    // why? because the node w/ final-letter never sets the compressed flag.
    // only the first...end-1 letters have the compressed flag set.

    // base32 (legacy) => 5 bits per char, +2 bits node metadata
    // utf8 (new)      => 8 bits per char, +2 bits node metadata
    //                   b00    b32        |  b00     utf
    // final-node     : 0x20 => 001 0 0000 | 0x100 => 0001 0000 0000
    // compressed-node: 0x40 => 010 0 0000 | 0x200 => 0010 0000 0000
    // flag/value-node: 0x60 => 011 0 0000 | 0x300 => 0011 0000 0000
    //                   b00    codec6 / b64
    // final-node     : 0x40 => 01 00 0000
    // compressed-node: 0x80 => 10 00 0000
    // flag/value-node: 0xc0 => 11 00 0000
    const finalMask = this.config.useCodec6 ? 0x40 : 0x100;
    const compressedMask = this.config.useCodec6 ? 0x80 : 0x200;
    const flagMask = this.config.useCodec6 ? 0xc0 : 0x300;

    const all1 = 0xffff_ffff; // 1s all 32 bits
    const maxbits = countSetBits(all1); // 32 bits

    // Write the unary encoding of the tree in level order.
    const bits = new BitWriter();
    const chars = [];

    // write the entry 0b10 (1 child) for root node
    bits.write(0x02, 2);

    this.stats = { children: 0, flags: 0, single: new Array(256).fill(0) };
    let start = Date.now();

    log.i("levelorder begin:", start);
    log.sys();
    // level-order bloats heap-size by 14G+
    const levelorder = this.levelorder();
    log.i("levelorder end: ", Date.now() - start);
    log.sys();

    this.root = null;
    this.cache = null;

    if (this.config.debug && global.gc) {
      // in test runs, a call to gc here takes 15m+
      global.gc();
      log.i("encode: gc");
      log.sys();
    }

    const level = levelorder.level;
    let nbb = 0;

    log.i(
      "levlen",
      level.length,
      "nodecount",
      this.nodeCount,
      " masks ",
      compressedMask,
      flagMask,
      finalMask
    );
    if (this.nodeCount !== level.length) {
      log.w("nodecount != len(level), re-check node-count calc in upsertFlag");
    }

    const l10 = (level.length / 10) | 0;
    for (let i = 0; i < level.length; i++) {
      const node = level[i];
      // clear out the reference
      level[i] = null;
      const childrenLength = node.len > 0 ? node.len | 0 : 0;
      const size = node.size > 0 ? node.size | 0 : 0;
      nbb += size;

      if (i % l10 === 0) {
        log.i("at encode[i]: " + i);
        // seems to show memory increases of 250M+
        log.sys();
      }
      this.stats.single[childrenLength] += 1;

      // set j lsb bits in int bw
      // each set bit marks one child
      let rem = size;
      let j = Math.min(rem, maxbits);
      while (j > 0) {
        const bw = all1 >>> (maxbits - j);
        bits.write(bw, j);
        rem -= j;
        j = Math.min(rem, maxbits);
      }
      // for (let j = 0; j < size; j++) bits.write(1, 1)
      // write 0 to mark the end of the node's child-size
      bits.write(0, 1);

      let value = node.letter;
      if (node.final) {
        value |= finalMask;
        this.stats.children += 1;
      }
      if (node.compressed) {
        value |= compressedMask;
      }
      if (node.flag === true) {
        value |= flagMask;
        this.stats.flags += 1;
      }
      chars.push(value);
      if (this.config.inspect) {
        this.inspect[i + "_" + node.letter] = {
          v: value,
          l: node.letter,
          f: node.final,
          c: node.compressed,
        };
      }
    }
    if (this.config.inspect) {
      let i = 0;
      for (const [k, v] of Object.entries(this.inspect)) {
        console.log(k, v);
        i += 1;
        if (i > 100) break;
      }
    }
    const elapsed2 = Date.now() - start;

    // Write the data for each node, using 6 bits for node. 1 bit stores
    // the "final" indicator. The other 5 bits store one of the 26 letters
    // of the alphabet.
    start = Date.now();
    // 2 extra bits to denote regular, compressed, final, flag node types
    const extraBit = 2;
    const bitslen = extraBit + this.proto.typ;
    log.i(
      "charslen: " + chars.length + ", bitslen: " + bitslen,
      " letterstart",
      bits.top
    );
    if (this.nodeCount * 2 + 1 !== bits.top) {
      log.w(
        "letterstart not the same as nodecount*2+1; re-check childrenSize calc"
      );
    }
    let k = 0;
    // the memory allocs driven by level-order & bit-writer above
    // are got rid of by the time we hit this portion of the code
    for (const c of chars) {
      if (k % ((chars.length / 10) | 0) === 0) {
        log.i("charslen: " + k);
        log.sys();
      }
      bits.write(c, bitslen);
      k += 1;
    }

    const elapsed = Date.now() - start;
    log.i(
      "size:",
      nbb,
      ", flags:",
      this.stats.flags,
      ", len:",
      this.stats.children,
      "\nelapsed.write.keys:",
      elapsed2,
      ", elapsed.write.values:",
      elapsed,
      "\nchildren:",
      this.stats.single,
      "\ncodec memoized:",
      this.proto.stats()
    );

    return bits.getData();
  },
};

function lex(a, b) {
  const n = Math.min(a.length, b.length);
  const lenDiff = a.length - b.length;
  if (n === 0) return lenDiff;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (d === 0) continue;
    return d;
  }
  return lenDiff;
}

async function processBlocklist(trie, bfile) {
  const patharr = bfile.split("/");
  const hosts = [];
  let discards = 0;

  // fname is an int always same as blocklistConfig's entry.value
  const fname = patharr[patharr.length - 1].split(".")[0];
  const f = fs.readFileSync(bfile, "utf8");

  if (f.length <= 0) {
    log.i("empty file", bfile);
    return [hosts, fname, discards];
  }

  // fname always corresponds to an immutable id for a given blocklist
  // fname should always equal conf[uid].value
  // reverse the value since it is prepended to the front of key
  const tag = codec.delim + fname;
  // if the tag is #173, rtag is 371# where # is a predefined delimiter
  const rtag = tag.split("").reverse().join("");

  if (trie.config.debug) {
    log.d(fname + "; adding: " + bfile, fname + " <-file | tag-> " + rtag);
  }

  const visited = new Set();
  const all = [];
  for (const h of f.split("\n")) {
    const trimmed = h.trim();
    if (trimmed.length === 0) continue;
    // TODO: move to allowlist
    if (trimmed.indexOf("rethinkdns.com") >= 0) continue;
    if (trimmed.indexOf("bravedns.com") >= 0) continue;
    if (trimmed.indexOf("celzero.com") >= 0) continue;
    if (trimmed.indexOf("rethinkfirewall.com") >= 0) continue;
    all.push(trimmed);
  }

  all.sort(lex);

  for (const dom of all) {
    // www.example.com -> [com, example, www]
    const subs = dom.split(".").reverse();
    let cur = null;
    let skip = false;
    for (const s of subs) {
      if (skip) break;
      // www . google . com
      cur = cur == null ? s : cur + "." + s;
      // if we've seen this subdomain before, skip it
      skip = visited.has(cur);
    }
    if (!skip) {
      visited.add(cur);
      const ht = rtag + dom;
      // transformer encodes (u8/u6) + reverses ht
      hosts.push(trie.transform(ht));
    } else {
      discards += 1;
    }
  }
  return [hosts, fname, discards];
}

export async function build(
  inFiles,
  outDir,
  blocklistConfig,
  trieConfig = null
) {
  trieConfig = withDefaults(trieConfig);
  log.i("building trie with opts", trieConfig);
  const t = new Trie(trieConfig);

  let hosts = [];
  try {
    // total number of blocklist files
    let totalfiles = 0;
    // total hosts in this files
    let totallines = 0;
    // discard hosts that are subdomains of other hosts in the same file
    let totaldiscards = 0;

    const promisedJobs = [];
    // for each blocklist file, extract the hosts, and add them to the trie
    for (const bfile of inFiles) {
      const j = processBlocklist(t, bfile);
      promisedJobs.push(j);
    }

    const results = await Promise.all(promisedJobs);
    const unames = compat.legacyNames(blocklistConfig);

    for (const r of results) {
      const [dom, f, discards] = r;

      if (!dom || dom.length <= 0) continue;
      log.i("id: " + f, "a: " + dom.length, "dis: " + discards);

      for (const x of dom) {
        hosts.push(x);
      }

      // uid is the legacy immutable id (3 letter char)
      // for a given blocklist file name, f
      const uid = unames[f];
      const lines = dom.length + discards;

      totallines += lines;
      totaldiscards += discards;
      blocklistConfig[uid].entries = lines;
      blocklistConfig[uid].discards = discards;
      totalfiles += 1;
    }

    log.i(
      "hosts:Total -> " + totallines,
      "| hosts:Discards -> " + totaldiscards,
      "| files:Total -> " + promisedJobs.length,
      "| files:Processed -> " + totalfiles
    );
  } catch (e) {
    log.e(e);
    throw e;
  }

  // if sorting isn't lexographical, trie.insert would not work, resulting
  // in broken search / lookups; this also shows up highlighting disparity
  // between trie.nodecount and no of nodes traversed by trie.levelorder
  hosts.sort(lex);

  const start = Date.now();
  log.i("building trie");
  log.sys();
  hosts.forEach((s) => t.insert(s));
  // fast array clear stackoverflow.com/a/1234337
  hosts.length = 0;
  hosts = [];
  if (global.gc) {
    log.sys();
    log.i("gc");
    global.gc();
  }

  log.i("encoding trie");
  log.sys();

  // generate trie-data
  const td = t.encode();
  const nodeCount = t.getNodeCount();

  let basicconfig = {
    version: 1,
    nodecount: nodeCount,
  };

  // assign trie-config defaults to basicconfig
  basicconfig = Object.assign(basicconfig, trieConfig);

  // create rank directory
  log.i("building rank; nodecount/L1/L2", nodeCount, L1, L2);
  const rddir = createRankDirectory(td, basicconfig);

  const ft = new FrozenTrie(td, rddir, basicconfig);
  const end = Date.now();

  log.i("time (ms) spent creating trie+rank: ", end - start);

  // serialize rank dir to u8/buffer
  const rd = rddir.directory.bytes;

  const ftnew = compat.unlegacy(blocklistConfig);
  const ftold = compat.legacy(blocklistConfig);
  // serialize filetag json
  const ftstr = JSON.stringify(ftnew);
  const ftstr2 = JSON.stringify(ftold);

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
  }

  // split td (which is u16) into multiple files
  const tdparts = await splitAndSaveTd(td.buffer, outDir);

  // tdparts is 0-indexed; ie, tdparts([0,1,2]) = 2 when len([0,1,2]) = 3
  basicconfig.tdparts = tdparts.length - 1;
  // register digests for td, rd, filetag
  basicconfig.tdmd5 = md5(td);
  basicconfig.rdmd5 = md5(rd);
  basicconfig.ftmd5 = md5(ftstr);

  log.i("saving trie/rank/filetag/basicconfig", basicconfig);

  const wg = [];

  const aw1 = fs.writeFile(outDir + "td.txt", td, function (err) {
    if (err) {
      log.e(err);
      throw err;
    }
    log.i("trie saved as td.txt");
  });
  wg.push(aw1);

  const aw2 = fs.writeFile(outDir + "rd.txt", rd, function (err) {
    if (err) {
      log.e(err);
      throw err;
    }
    log.i("rank saved as rd.txt");
  });
  wg.push(aw2);

  const aw3 = fs.writeFile(outDir + "filetag.json", ftstr, function (err) {
    if (err) {
      log.e(err);
      throw err;
    }
    log.i("filetag.json saved");
  });
  wg.push(aw3);

  const outlegacy = outDir + "filetag-legacy.json";
  const aw3legacy = fs.writeFile(outlegacy, ftstr2, function (err) {
    if (err) {
      log.e(err);
      throw err;
    }
    log.i("filetag-legacy.json saved");
  });
  wg.push(aw3legacy);

  const aw4 = fs.writeFile(
    outDir + "basicconfig.json",
    JSON.stringify(basicconfig),
    function (err) {
      if (err) {
        log.e(err);
        throw err;
      }
      log.i("basicconfig.json saved");
    }
  );
  wg.push(aw4);

  await Promise.all(wg);

  log.sys();
  log.i("Lookup a few domains in this new trie");

  const testdomains = [
    "aws.com",
    "sg-ssl.effectivemeasure.net",
    "staging.connatix.com",
    "ads.redlightcenter.com",
    "oascentral.chicagobusiness.com",
    "simpsonitos.com",
    "putlocker.fyi",
    "segment.io",
    "hearst.gscontxt.net",
    "xnxx.com",
    "google.ae",
    "celzero.com",
  ];
  for (const domainname of testdomains) {
    const ts = t.transform(domainname);
    const sresult = ft.lookup(ts);
    log.i("looking up domain: " + domainname, "result: ");
    if (sresult) {
      for (const [d, value] of sresult) {
        log.i("for", d + ":", flagsToTags(value));
      }
    } else {
      log.i(domainname, "not found in trie");
    }
  }
}

// buf must be either TypedArray or node:Buffer
function md5(buf) {
  return createHash("md5").update(buf).digest("hex");
}

// ab is array-buffer (not node:Buffer)
function splitAndSaveTd(ab, dirent, mib = 30) {
  // n is zero-indexed, ie mib = 30 and...
  // if len = 29, then 29 / 30 => 0 => [00] => 1 split
  // if len = 31, then 31 / 30 => 1 => [00, 01] => 2 splits
  const step = mib * 1024 * 1024;
  const len = ab.byteLength;
  const n = Math.floor(len / step);
  const promisedtds = [];
  let next = 0;
  for (let i = 0; i <= n; i++) {
    // td00.txt, td01.txt, td02.txt, ... , td98.txt, td100.txt, ...
    const fname =
      "td" +
      i.toLocaleString("en-US", {
        minimumIntegerDigits: 2,
        useGrouping: false,
      }) +
      ".txt";

    const begin = next;
    const end = Math.min(begin + step, len);
    const chunk = new Uint8Array(ab).subarray(begin, end);

    const promisedFile = fs.writeFile(dirent + fname, chunk, function (err) {
      if (err) {
        log.e(err);
        throw err;
      }
      log.i(begin, " trie-split to", end, "saved as", fname);
    });

    next += step;
    promisedtds.push(promisedFile);
  }
  return Promise.all(promisedtds);
}
