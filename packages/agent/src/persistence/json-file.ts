import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeJsonFileAtomic(filePath: string, value: unknown, mode = 0o600): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", mode);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, filePath);
		await chmod(filePath, mode).catch(() => undefined);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
