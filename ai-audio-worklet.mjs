import {StreamingResampler, calculateRms, floatToPcm16} from './ai-audio-utils.mjs';

class GrinchAiCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = options.processorOptions || {};
        this.outputRate = processorOptions.outputRate || 24000;
        this.batchSize = processorOptions.batchSize || 2400;
        this.resampler = new StreamingResampler(sampleRate, this.outputRate);
        this.pending = [];
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) {
            return true;
        }

        const mono = new Float32Array(input[0].length);
        for (let channel = 0; channel < input.length; channel++) {
            const channelData = input[channel];
            for (let i = 0; i < mono.length; i++) {
                mono[i] += channelData[i] / input.length;
            }
        }

        const resampled = this.resampler.push(mono);
        for (let i = 0; i < resampled.length; i++) {
            this.pending.push(resampled[i]);
        }

        while (this.pending.length >= this.batchSize) {
            const batch = Float32Array.from(this.pending.splice(0, this.batchSize));
            const pcm = floatToPcm16(batch);
            this.port.postMessage({
                type: 'audio',
                level: calculateRms(batch),
                pcm: pcm.buffer
            }, [pcm.buffer]);
        }

        return true;
    }
}

registerProcessor('grinch-ai-capture', GrinchAiCaptureProcessor);
