export class StreamingResampler {
    constructor(inputRate, outputRate) {
        if (!(inputRate > 0) || !(outputRate > 0)) {
            throw new RangeError('Sample rates must be positive');
        }

        this.ratio = inputRate / outputRate;
        this.position = 0;
        this.carry = new Float32Array(0);
    }

    push(input) {
        const samples = input instanceof Float32Array ? input : Float32Array.from(input || []);
        const data = new Float32Array(this.carry.length + samples.length);
        data.set(this.carry);
        data.set(samples, this.carry.length);

        const output = [];
        while (this.position + 1 < data.length) {
            const leftIndex = Math.floor(this.position);
            const fraction = this.position - leftIndex;
            const value = data[leftIndex] + ((data[leftIndex + 1] - data[leftIndex]) * fraction);
            output.push(value);
            this.position += this.ratio;
        }

        const consumed = Math.floor(this.position);
        this.carry = data.slice(consumed);
        this.position -= consumed;

        return Float32Array.from(output);
    }
}

export function floatToPcm16(samples) {
    const result = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        result[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    }

    return result;
}

export function calculateRms(samples) {
    if (samples.length === 0) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }

    return Math.sqrt(sum / samples.length);
}
