/**
 * Worst-case inputs for the U38 limits: transactions at the instruction and authorization caps,
 * and the ABI offset-aliasing Multicall3 calldata (many array offsets pointing at one large
 * `bytes`). Seed-free random keys: nothing here is signed over a real key or sent anywhere.
 */
import { address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rnd = (n = 32): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

function shortvec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

/** Three addresses to pass as `knownOwners`, which makes capture derive ATAs for each. */
export const KNOWN_OWNERS = Array.from({ length: 3 }, () => getAddressDecoder().decode(rnd()));

/** A base64 SVM transaction with `instructions` SPL `TransferChecked`-shaped instructions. */
export function svmTx(instructions: number): string {
  const enc = getAddressEncoder();
  const authority = rnd();
  const tokenProgram = enc.encode(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  const parts: number[] = [1, 0, 1, ...shortvec(5)];
  for (const key of [authority, rnd(), rnd(), rnd(), tokenProgram]) parts.push(...key);
  parts.push(...rnd(), ...shortvec(instructions));
  for (let i = 0; i < instructions; i++) {
    parts.push(4, 4, 1, 3, 2, 0, 10, 12, 1, 0, 0, 0, 0, 0, 0, 0, 6);
  }
  return Buffer.from([1, ...rnd(64), ...parts]).toString("base64");
}

/** A serialized EIP-7702 transaction carrying `authorizations` signed authorizations. */
export async function evm7702Tx(authorizations: number): Promise<Hex> {
  const account = privateKeyToAccount(keccak256(toBytes("u38-fixture-key")));
  const authorizationList = [];
  for (let i = 0; i < authorizations; i++) {
    authorizationList.push(
      await account.signAuthorization({
        chainId: 84532,
        address: "0x2222222222222222222222222222222222222222",
        nonce: i,
      }),
    );
  }
  return account.signTransaction({
    type: "eip7702",
    chainId: 84532,
    nonce: 0,
    to: "0x3333333333333333333333333333333333333333",
    gas: 100000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    authorizationList,
  });
}

const word = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, "0");

/**
 * Multicall3 `aggregate3` calldata whose `calls` array has `calls` offsets that all point at one
 * tuple holding `bytesLen` bytes, so a decoder that follows offsets does `calls * bytesLen` work.
 */
export function aliasedAggregate3(calls: number, bytesLen: number): string {
  const selector = "82ad56cb"; // aggregate3((address,bool,bytes)[])
  let hex = selector + word(32) + word(calls);
  for (let i = 0; i < calls; i++) hex += word(calls * 32);
  hex += word(0) + word(1) + word(96) + word(bytesLen);
  hex += "ab".repeat(bytesLen) + "00".repeat((32 - (bytesLen % 32)) % 32);
  return `0x${hex}`;
}
