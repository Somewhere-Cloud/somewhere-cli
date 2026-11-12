import { connect } from 'node:net';

export async function testAddressOrder(origin: string): Promise<boolean> {
  const url = new URL(origin);
  const probe = (family: 4 | 6): Promise<boolean> => new Promise(resolve => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), family });
    const finish = (ok: boolean): void => { clearTimeout(deadline); socket.destroy(); resolve(ok); };
    const deadline = setTimeout(() => finish(false), 300);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  const [ipv6, ipv4] = await Promise.all([probe(6), probe(4)]);
  if (!ipv6 && !ipv4) throw new Error(`cannot reach ${url.hostname}`);
  return !ipv6 && ipv4;
}
