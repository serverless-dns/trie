/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// impl based on S Hanov's succinct-trie: stevehanov.ca/blog/?id=120

import * as codec from "./codec.js";
import { tagsToFlags } from "./stamp.js";
import {
  W,
  bufferView,
  periodEncVal,
  L1,
  L2,
  TxtEnc,
  TxtDec,
  ENC_DELIM,
  config,
} from "./config.js";
import { RankDirectory } from "./rank.js";

/**
 * This class is used for traversing the succinctly encoded trie.
 */
function FrozenTrieNode(trie, index) {
  let finCached;
  let whCached;
  let comCached;
  let fcCached;
  let chCached;
  let valCached;
  let flagCached;
  let wordCached;
  let cursorCached;

  this.trie = trie;
  this.index = index;

  this.final = () => {
    if (typeof finCached === "undefined") {
      // final node is 0x1ii => 0001 iiii iiii
      // where iiii iiii is utf-8 encoded letter()
      // a final-node never sets compressed-flag; if it does, it's a value-node
      // github.com/serverless-dns/blocklists/blob/c858b3a0/trie.js#L1018-L1032
      const extrabits = 1;
      const bitsize = 1; // size of the final bit
      finCached =
        this.trie.data.get(
          this.trie.letterStart + this.index * this.trie.bitslen + extrabits,
          bitsize
        ) === 1;
    }
    return finCached;
  };

  this.where = () => {
    if (typeof whCached === "undefined") {
      // bits for node-headers that are 2-bit wide per trie-node (used to diff
      // between none/final/value/compressed node-types) should be skipped
      // ie, a letter is 0bxxhhhhllll, where xx are the 2-bit node-header
      const extrabits = this.trie.extraBit;
      const bitsize = this.trie.bitslen - extrabits;
      whCached = this.trie.data.get(
        this.trie.letterStart + this.index * this.trie.bitslen + extrabits,
        bitsize
      );
    }
    return whCached;
  };

  this.compressed = () => {
    // compressed-node is of form 0x2ii => 0010 iiii iiii
    const extrabits = 0;
    const bitsize = 1;
    if (typeof comCached === "undefined") {
      comCached =
        this.trie.data.get(
          this.trie.letterStart + this.index * this.trie.bitslen + extrabits,
          bitsize
        ) === 1;
    }
    return comCached;
  };

  this.flag = () => {
    // flag-node is of form 0x3ii => 0011 iiii iiii;
    // that is, both compressed and final bits are set
    if (typeof flagCached === "undefined") {
      flagCached = this.compressed() && this.final();
    }
    return flagCached;
  };

  this.letter = () => this.where();

  this.radix = (parent, cachecursor = null) => {
    if (typeof wordCached !== "undefined") return [wordCached, cursorCached];

    // location of this child among all other children of its parent
    const loc = this.index - parent.firstChild();
    // todo: check for index less than letterStart?
    const prev = loc > 0 ? parent.getChild(loc - 1) : null;
    const isPrevNodeCompressed = prev && prev.compressed() && !prev.flag();
    const isThisNodeCompressed = this.compressed() && !this.flag();

    if (isThisNodeCompressed || isPrevNodeCompressed) {
      let cc = null;
      if (this.trie.nodecache != null) {
        cc = this.trie.nodecache.find(this.index, cachecursor);
      }
      if (cc != null && cc.value != null) {
        wordCached = cc.value;
        cursorCached = cc.cursor;
        if (config.debug) console.log("\t\t\tnode-c-hit", this.index);
        return [wordCached, cursorCached];
      }

      if (config.debug) console.log("\t\t\tnode-c-miss, add:", this.index);

      const startchild = [];
      const endchild = [];
      let start = 0;
      let end = 0;

      startchild.push(this);
      start += 1;

      // startchild len > word len terminate
      // fixme: startchild first letter != w first letter terminate
      do {
        const temp = parent.getChild(loc - start);
        if (!temp.compressed()) break;
        if (temp.flag()) break;
        startchild.push(temp);
        start += 1;
      } while (true);

      // if the child itself the last-node in the sequence, nothing
      // to do, there's no endchild to track; but otherwise, loop:
      if (isThisNodeCompressed) {
        do {
          end += 1;
          const temp = parent.getChild(loc + end);
          endchild.push(temp);
          if (!temp.compressed()) break;
          // would not encounter a flag-node whilst probing higher indices
          // as flag-nodes are rooted at 0..upto first letter-node
        } while (true);
      }
      const nodes = startchild.reverse().concat(endchild);
      const w = nodes.map((n) => n.letter());
      // start index of this compressed node in the overall trie
      const lo = this.index - start + 1;
      // end index of this compressed node in the overall trie
      const hi = this.index + end;
      wordCached = {
        // the entire word represented by this compressed-node as utf8 uints
        word: w,
        // start-index of this compressed-node in its parent
        loc: lo - parent.firstChild(),
        // the last node contains refs to all children of this compressed-node
        branch: nodes[nodes.length - 1],
      };
      // cache compressed-nodes against their trie indices (spawn)
      if (this.trie.nodecache != null) {
        this.trie.nodecache.put(lo, hi, wordCached);
      }
    } else {
      wordCached = {
        word: [this.letter()],
        loc: loc,
        branch: this,
      };
    }

    return [wordCached, cursorCached || null];
  };

  this.debug = () => {
    log.d(
      this.index +
        " :i, fc: " +
        this.firstChild() +
        " tl: " +
        this.letter() +
        " c: " +
        this.compressed() +
        " f: " +
        this.final() +
        " wh: " +
        this.where() +
        " flag: " +
        this.flag()
    );
  };

  this.firstChild = () => {
    if (!fcCached) {
      fcCached = this.trie.directory.select(0, rhis.index + 1) - this.index;
    }
    return fcCached;
  };

  this.childOfNextNode = () => {
    if (!chCached) {
      chCached = this.trie.directory.select(0, this.index + 2) - this.index - 1;
    }
    return chCached;
  };

  this.childCount = () => this.childOfNextNode() - this.firstChild();

  this.value = () => {
    if (typeof valCached === "undefined") {
      const childcount = this.childCount();
      const value = [];
      const optvalue = [];
      let i = 0;
      let j = 0;
      if (config.debug) {
        console.log("cur:i/l/c", this.index, this.letter(), childcount);
      }
      // value-nodes are all children from 0...node.flag() is false
      while (i < childcount) {
        const valueChain = this.getChild(i);
        if (config.debug) {
          console.log("vc no-flag end i/l", i, valueChain.letter());
          console.log("f/idx/v", valueChain.flag(), valueChain.index, value);
        }
        if (!valueChain.flag()) {
          break;
        }

        if (config.useCodec6) {
          // retrieve letter (6 bits) as-is
          value.push(valueChain.letter());
          j += 1;
        } else {
          // retrieve letter and big-endian it in a bit-string (16 bits)
          if (i % 2 === 0) {
            value.push(valueChain.letter() << 8);
          } else {
            value[j] = value[j] | valueChain.letter();
            j += 1;
          }
        }
        i += 1;
      }
      // maximum number of flags stored as-is is 3.
      // for codec b6 (6 bits), max is len 4 (8*3/6 bits each)
      // for codec b8 (8 bits), max is len 3 (8*3/8 bits each)
      if (config.optflags && optvalue.length <= 4) {
        // note: decode8 is a no-op for codec typ b8
        const u8 = config.useCodec6 ? TxtDec.decode8(optvalue) : optvalue;
        const fl = new Array(u8.length);
        u8.forEach((u, i) => (fl[i] = u));
        const tt = tagsToFlags(fl);
        valCached = codec.str2buf(tt);
        if (config.debug) log.d("buf", valCached, "tag", tt, "flag", fl);
        if (config.debug) log.d("enc u8", u8, "dec u6", optvalue);
      } else {
        valCached = config.useCodec6 ? TxtDec.decode16raw(value) : value;
      }
    }

    return valCached;
  };

  if (config.debug) {
    console.log(index, ":i, fc:", this.firstChild(), "tl:", this.letter());
    console.log("c:", this.compressed(), "f:", this.final());
    console.log("wh:", this.where(), "flag:", this.flag());
  }
}

FrozenTrieNode.prototype = {
  /**
   * Returns the number of children.
   */
  getChildCount: function () {
    return this.childCount();
  },

  /**
   * Returns the FrozenTrieNode for the given child.
   * @param {*} index The 0-based index of the child of this node.
   * For example, if the node has 5 children, and you wanted the 0th one,
   * pass in 0.
   * @returns
   */
  getChild: function (index) {
    return this.trie.getNodeByIndex(this.firstChild() + index);
  },

  lastFlagChild: function () {
    const childcount = this.getChildCount();

    let i = 0;
    // value-nodes (starting at position 0) preceed all their other
    // siblings. That is, in a node{f1, f2, ..., fn, l1, l2 ...},
    // f1..fn are flags (value-nodes), then letter nodes l1..ln follow
    while (i < childcount) {
      const c = this.getChild(i);
      // value-node (flag) ended at prev index
      if (!c.flag()) return i - 1;
      i += 1;
    }

    // likely all children nodes are flags (value-nodes)
    return i;
  },
};

/**
 * The FrozenTrie is used for looking up words in the encoded trie.
 * @param {*} data A string representing the encoded trie.
 * @param {*} directoryData A string representing the RankDirectory.
 * The global L1 and L2 constants are used to determine the L1Size and L2size.
 * @param {*} nodeCount The number of nodes in the trie.
 */
function FrozenTrie(data, rdir, nodeCount) {
  this.init(data, rdir, nodeCount);
}

FrozenTrie.prototype = {
  init: function (trieData, rdir, nodeCount, cache) {
    this.data = new BitString(trieData);
    // pass the rank directory instead of data
    this.directory = rdir;

    this.extraBit = 2;
    this.bitslen = TxtEnc.typ + this.extraBit;

    // The position of the first bit of the data in 0th node. In non-root
    // nodes, this would contain bitslen letters.
    this.letterStart = nodeCount * 2 + 1;

    // must impl put(low, high, data) and {v, cursor} = find(i, cursor)
    this.nodecache = cache;
  },

  /**
   * Retrieve the FrozenTrieNode of the trie, given its index in level-order.
   */
  getNodeByIndex: function (index) {
    // todo: what if index less than letterStart?
    return new FrozenTrieNode(this, index);
  },

  /**
   * Retrieve the root node.
   */
  getRoot: function () {
    return this.getNodeByIndex(0);
  },

  /**
   * Look-up a word in the trie. Returns true if and only if the word exists
   * in the trie.
   */
  lookup: function (word) {
    const debug = config.debug;

    const index = word.lastIndexOf(ENC_DELIM[0]);
    if (index > 0) word = word.slice(0, index);

    // cursor tracks position of previous cache-hit in frozentrie:nodecache
    let cachecursor = null;
    // the output of this fn
    let returnValue = false;
    // the current trie node to query
    let node = this.getRoot();
    // index in the incoming word utf-8 array
    let i = 0;
    while (i < word.length) {
      if (node == null) {
        if (debug) console.log("...no more nodes, lookup complete");
        return returnValue;
      }

      // if '.' is encountered, capture the interim node.value();
      // for ex: s.d.com => return values for com. & com.d. & com.d.s
      if (periodEncVal[0] === word[i] && node.final()) {
        if (!returnValue) returnValue = new Map();
        const partial = TxtDec.decode(word.slice(0, i).reverse());
        returnValue.set(partial, node.value());
      }

      const lastFlagNodeIndex = node.lastFlagChild();
      if (debug) {
        console.log("count/i/w:", node.getChildCount(), i, word[i]);
        console.log("node-w:", node.letter(), "flag-at:", lastFlagNodeIndex);
      }

      // iff flags (value-node) exist but no other children, terminate lookup
      // ie: in child{f1, f2, ..., fn}; all children are flags (value-nodes)
      if (lastFlagNodeIndex >= node.getChildCount() - 1) {
        if (debug) console.log("...no more children, rem:", word.slice(i));
        return returnValue;
      }

      let high = node.getChildCount();
      let low = lastFlagNodeIndex;
      let next = null;

      while (high - low > 1) {
        const probe = ((high + low) / 2) | 0;
        const child = node.getChild(probe);
        const [r, cc] = child.radix(node, cachecursor);
        const comp = r.word;
        const w = word.slice(i, i + comp.length);

        if (debug) {
          console.log("\t\tl/h:", low, high, "p:", probe, "s:", comp, "w:", w);
          const pr = cachecursor && cachecursor.range;
          const nr = cc && cc.range;
          if (cc) console.log("index", child.index, "now:cc", nr, "p:cc", pr);
        }

        cachecursor = cc != null ? cc : cachecursor;

        if (comp[0] > w[0]) {
          // binary search the lower half of the trie
          high = r.loc;
          if (debug) console.log("\t\tnew h", high, comp[0], ">", w[0]);
          continue;
        } else if (comp[0] < w[0]) {
          // binary search the upper half of the trie beyond r.word
          low = r.loc + comp.length - 1;
          if (debug) console.log("\t\tnew l", low, comp[0], "<", w[0]);
          continue;
        } // else, comp[0] === w[0] and so, match up the rest of comp

        // if word length is less than current node length, no match
        // for ex, if word="abcd" and cur-node="abcdef", then bail
        if (w.length < comp.length) return returnValue;
        for (let u = 0; u < comp.length; u++) {
          // bail on mismatch, ex word="axyz" and cur-node="axxx"
          if (w[u] !== comp[u]) return returnValue;
        }

        if (debug) console.log("\t\tit:", probe, "r", r.loc, "break");

        // final child of a compressed-node has refs to all its children
        next = r.branch;
        // move ahead to now compare rest of the letters in word[i:length]
        i += w.length;
        break;
      }

      if (debug) console.log("\tnext:", next && next.letter());
      node = next; // next is null when no match is found
    }

    // the entire word to be looked-up has been iterated over, see if
    // we are on a final-node to know if we've got a match in the trie
    if (node.final()) {
      if (!returnValue) returnValue = new Map();
      returnValue.set(TxtDec.decode(word.reverse()), node.value());
    }

    if (debug) console.log("...lookup complete:", returnValue);

    // fixme: see above re returning "false" vs [false] vs [[0], false]
    return returnValue;
  },
};

export function createTrie(tdbuf, rdbuf, config) {
  // tdbuf, rdbuf must be untyped arraybuffers on all platforms
  // bufutil.concat, as one example, creates untyped arraybuffer,
  // as does nodejs' Buffer module. If what's passed is a typedarray,
  // then bufferView would not work as expected. For example,
  // tdbuf is Uint8Array([0x00, 0xff, 0xf3, 0x00]), then
  // tdv is Uint16Array([0x00, 0xff, 0xff, 0x00]), but
  // the expectation is that tdv is a "view" and not a copy of uint8
  // that is, tdv must instead be Uint16Array([0xff00, 0x00f3])
  const tdv = new bufferView[W](tdbuf);
  const rdv = new bufferView[W](rdbuf);
  const nc = config.nodecount;
  const numbits = config.nodecount * 2 + 1;
  const rd = new RankDirectory(rdv, tdv, numbits, L1, L2);

  return new FrozenTrie(tdv, rd, nc);
}