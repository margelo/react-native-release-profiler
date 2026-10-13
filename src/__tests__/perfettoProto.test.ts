import { bytes, fields, message, uint, varint } from '../perfettoProto';

describe('perfettoProto', () => {
  it.each([
    0n,
    1n,
    127n,
    128n,
    300n,
    2n ** 31n,
    2n ** 53n + 1n,
    2n ** 64n - 1n,
  ])('round-trips varint %s', (value) => {
    const [field] = [...fields(uint(8, value))];
    expect(field).toEqual({ id: 8, value });
  });

  it('keeps nanosecond boot timestamps exact beyond Number precision', () => {
    const timestamp = 880116880688985123n;
    const [field] = [...fields(uint(8, timestamp))];
    expect(field!.value).toBe(timestamp);
  });

  it('rejects values outside uint64', () => {
    expect(() => varint(-1n)).toThrow('outside uint64');
    expect(() => varint(2n ** 64n)).toThrow('outside uint64');
  });

  it('decodes nested length-delimited messages', () => {
    const inner = message(uint(1, 42), bytes(2, 'hermes'));
    const outer = [...fields(bytes(66, inner))];
    expect(outer).toHaveLength(1);
    const decoded = [...fields(outer[0]!.value as Buffer)];
    expect(decoded[0]).toEqual({ id: 1, value: 42n });
    expect((decoded[1]!.value as Buffer).toString()).toBe('hermes');
  });

  it('rejects truncated payloads and varints', () => {
    const truncated = bytes(1, 'abcdef').subarray(0, 4);
    expect(() => [...fields(truncated)]).toThrow('truncated');
    expect(() => [...fields(Buffer.from([0x08, 0x80]))]).toThrow('varint');
  });

  it('rejects group wire types', () => {
    expect(() => [...fields(Buffer.from([0x0b]))]).toThrow();
  });
});
