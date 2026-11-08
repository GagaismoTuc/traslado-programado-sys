import { createServer, type Server, type Socket } from "node:net";

export type HeldPort = { port: number; close: () => Promise<void> };

// Listeners on one port, by default on the wildcard address and every address a server could bind it on: on Windows a
// listener on the wildcard address does not stop another bind on 0.0.0.0 or 127.0.0.1, on Linux it does and those
// extra listens fail, which is fine. Without `answer` they accept connections and never answer them.
export async function holdPort(options: { answer?: (socket: Socket) => void; hosts?: (string | undefined)[] } = {}): Promise<HeldPort> {
  const { answer, hosts = [undefined, "0.0.0.0", "127.0.0.1", "::1"] } = options;
  const sockets = new Set<Socket>();
  const holders: Server[] = [];
  const hold = async (port: number, host: string | undefined) => {
    const holder = createServer((socket) => {
      sockets.add(socket);
      answer?.(socket);
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(port, host, resolve);
    });
    holders.push(holder);
    return (holder.address() as { port: number }).port;
  };
  const [first, ...rest] = hosts;
  const port = await hold(0, first);
  for (const host of rest) await hold(port, host).catch(() => undefined);
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(holders.map((holder) => new Promise((resolve) => holder.close(resolve))));
    },
  };
}
