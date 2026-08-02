import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingResampler, calculateRms, floatToPcm16} from '../ai-audio-utils.mjs';

test('streaming resampler converts 48 kHz to 24 kHz across chunks', function () {
    const resampler = new StreamingResampler(48000, 24000);
    const first = resampler.push(Float32Array.from({length: 128}, function (_, index) { return index / 128; }));
    const second = resampler.push(Float32Array.from({length: 128}, function (_, index) { return (index + 128) / 256; }));

    assert.equal(first.length, 64);
    assert.equal(second.length, 64);
});

test('PCM conversion clips out-of-range values', function () {
    const pcm = floatToPcm16([-2, -1, 0, 1, 2]);
    assert.deepEqual(Array.from(pcm), [-32768, -32768, 0, 32767, 32767]);
});

test('RMS reports silence and a constant signal', function () {
    assert.equal(calculateRms(new Float32Array(4)), 0);
    assert.equal(calculateRms(Float32Array.from([0.5, 0.5, 0.5, 0.5])), 0.5);
});
