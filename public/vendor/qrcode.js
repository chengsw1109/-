/* Minimal QR Code generator (byte mode), vendored for browser-ptt.
 *
 * Adapted from Project Nayuki's "QR Code generator library" (MIT License):
 *   https://www.nayuki.io/page/qr-code-generator-library
 * Trimmed to byte-mode encoding and matrix output. No external dependencies,
 * no build step — exposes `QR.encode(text, ecl)` returning a boolean matrix.
 *
 * MIT License. Copyright (c) Project Nayuki. (Portions adapted.)
 */
(function (root) {
  'use strict';

  var MIN_VERSION = 1, MAX_VERSION = 40;

  // Error-correction level -> format bits.
  var ECL = {
    L: { ord: 0, bits: 1 },
    M: { ord: 1, bits: 0 },
    Q: { ord: 2, bits: 3 },
    H: { ord: 3, bits: 2 },
  };

  // ECC codewords per block, indexed [eclOrd][version]. Index 0 is padding.
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function getNumDataCodewords(ver, eclOrd) {
    return Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[eclOrd][ver] * NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
  }

  // GF(256) multiply, primitive polynomial 0x11D (no lookup tables needed).
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsComputeDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var j = 0; j < degree; j++) {
      for (var k = 0; k < result.length; k++) {
        result[k] = rsMultiply(result[k], root);
        if (k + 1 < result.length) result[k] ^= result[k + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  function rsComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= rsMultiply(coef, factor);
      });
    });
    return result;
  }

  function QrCode(version, eclOrd, dataCodewords, mask) {
    this.version = version;
    this.size = version * 4 + 17;
    this.eclOrd = eclOrd;
    var size = this.size;
    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < size; i++) {
      this.modules.push(new Array(size).fill(false));
      this.isFunction.push(new Array(size).fill(false));
    }
    this.drawFunctionPatterns();
    var allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    if (mask < 0) {
      var minPenalty = Infinity;
      for (var m = 0; m < 8; m++) {
        this.applyMask(m);
        this.drawFormatBits(m);
        var penalty = this.getPenaltyScore();
        if (penalty < minPenalty) { mask = m; minPenalty = penalty; }
        this.applyMask(m); // undo
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  QrCode.prototype.getModule = function (x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
  };

  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function () {
    var size = this.size, i;
    for (i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    var alignPos = this.getAlignmentPatternPositions();
    var numAlign = alignPos.length;
    for (i = 0; i < numAlign; i++) {
      for (var j = 0; j < numAlign; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
        }
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrCode.prototype.drawFormatBits = function (mask) {
    var data = (ECL_BY_ORD[this.eclOrd].bits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var k;
    for (k = 0; k <= 5; k++) this.setFunctionModule(8, k, getBit(bits, k));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (k = 9; k < 15; k++) this.setFunctionModule(14 - k, 8, getBit(bits, k));
    var size = this.size;
    for (k = 0; k < 8; k++) this.setFunctionModule(size - 1 - k, 8, getBit(bits, k));
    for (k = 8; k < 15; k++) this.setFunctionModule(8, size - 15 + k, getBit(bits, k));
    this.setFunctionModule(8, size - 8, true);
  };

  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = this.size - 11 + (j % 3), b = Math.floor(j / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  QrCode.prototype.getAlignmentPatternPositions = function () {
    if (this.version === 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version === 32) ? 26 :
      Math.ceil((this.size - 13) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  };

  QrCode.prototype.addEccAndInterleave = function (data) {
    var ver = this.version, eclOrd = this.eclOrd;
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[eclOrd][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = rsComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var j = 0; j < blocks[0].length; j++) {
      for (var b = 0; b < blocks.length; b++) {
        if (j !== shortBlockLen - blockEccLen || b >= numShortBlocks) {
          result.push(blocks[b][j]);
        }
      }
    }
    return result;
  };

  QrCode.prototype.drawCodewords = function (data) {
    var size = this.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var size = this.size, result = 0, x, y;
    var mods = this.modules;
    // Rows / columns of same-color runs
    for (y = 0; y < size; y++) {
      var runColor = false, runX = 0;
      for (x = 0; x < size; x++) {
        if (mods[y][x] === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
        else { runColor = mods[y][x]; runX = 1; }
      }
    }
    for (x = 0; x < size; x++) {
      var runColorC = false, runY = 0;
      for (y = 0; y < size; y++) {
        if (mods[y][x] === runColorC) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
        else { runColorC = mods[y][x]; runY = 1; }
      }
    }
    // 2x2 blocks
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = mods[y][x];
        if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) result += 3;
      }
    }
    // Finder-like patterns
    for (y = 0; y < size; y++) {
      var bits = 0;
      for (x = 0; x < size; x++) {
        bits = ((bits << 1) & 0x7FF) | (mods[y][x] ? 1 : 0);
        if (x >= 10 && (bits === 0x05D || bits === 0x5D0)) result += 40;
      }
    }
    for (x = 0; x < size; x++) {
      var bitsC = 0;
      for (y = 0; y < size; y++) {
        bitsC = ((bitsC << 1) & 0x7FF) | (mods[y][x] ? 1 : 0);
        if (y >= 10 && (bitsC === 0x05D || bitsC === 0x5D0)) result += 40;
      }
    }
    // Balance of dark/light
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mods[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  var ECL_BY_ORD = [ECL.L, ECL.M, ECL.Q, ECL.H];

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // Build the data codewords (byte mode) then choose the smallest version.
  function encode(text, eclName) {
    var ecl = ECL[eclName || 'M'];
    var bytes = utf8Bytes(text);

    // Find smallest version that fits at the requested ECL.
    var version = -1, dataUsedBits = 0, dataCapacityBits = 0;
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      dataCapacityBits = getNumDataCodewords(v, ecl.ord) * 8;
      var ccbits = v < 10 ? 8 : 16; // byte-mode char count bits
      dataUsedBits = 4 + ccbits + bytes.length * 8;
      if (dataUsedBits <= dataCapacityBits) { version = v; break; }
    }
    if (version < 0) throw new Error('Data too long for a QR code');

    // Assemble bit buffer.
    var bb = [];
    appendBits(bb, 0x4, 4); // byte mode
    appendBits(bb, bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) appendBits(bb, bytes[i], 8);

    var capacityBits = getNumDataCodewords(version, ecl.ord) * 8;
    appendBits(bb, 0, Math.min(4, capacityBits - bb.length));
    appendBits(bb, 0, (8 - bb.length % 8) % 8);
    for (var pad = 0xEC; bb.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(bb, pad, 8);

    var dataCodewords = [];
    for (var b = 0; b < bb.length; b += 8) {
      var byteVal = 0;
      for (var j = 0; j < 8; j++) byteVal = (byteVal << 1) | bb[b + j];
      dataCodewords.push(byteVal);
    }
    return new QrCode(version, ecl.ord, dataCodewords, -1);
  }

  function appendBits(bb, val, len) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  function utf8Bytes(str) {
    var out = [];
    var encoded = unescape(encodeURIComponent(str));
    for (var i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
    return out;
  }

  var QR = { encode: encode };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(typeof window !== 'undefined' ? window : this);
