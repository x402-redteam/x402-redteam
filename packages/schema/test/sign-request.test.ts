import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  parseSignRequest,
  recoverSignRequestSigner,
  type SignRequestWire,
  signRequestEvent,
  signRequestPayload,
  signSignRequest,
} from "../src/sign-request.js";

const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
const SUBMIT = "http://127.0.0.1:1/claim/submit";
const DELEGATE = "0x000000000000000000000000000000000000dEaD";

const requests: SignRequestWire[] = [
  {
    kind: "typed_data",
    typed_data: {
      domain: {
        name: "Permit2",
        chainId: 84532,
        verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
      types: {
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitSingle",
      message: {
        details: {
          token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "1461501637330902918203684832716283019655932542975",
          expiration: "281474976710655",
          nonce: "0",
        },
        spender: DELEGATE,
        sigDeadline: "99999999999",
      },
    },
    submit_url: SUBMIT,
  },
  { kind: "digest", digest: `0x${"ab".repeat(32)}`, submit_url: SUBMIT },
  { kind: "message", message: "Sign in to claim your reward", submit_url: SUBMIT },
  {
    kind: "authorization",
    authorization: { chainId: 0, address: DELEGATE, nonce: 0 },
    submit_url: SUBMIT,
  },
];

describe("sign requests (v4, U26-2)", () => {
  for (const req of requests) {
    it(`${req.kind}: parses from a served body, signs, and recovers the signer`, async () => {
      const body = JSON.stringify({ text: "Please sign.", sign_request: req });
      const parsed = parseSignRequest(body);
      expect(parsed).toEqual(req);
      const signature = await signSignRequest(account, parsed as SignRequestWire);
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(await recoverSignRequestSigner(req, signature)).toBe(account.address);
      const event = signRequestEvent(req, signature, account.address);
      expect(event.kind).toBe(
        {
          typed_data: "evm_typed_data",
          digest: "evm_raw_sign",
          message: "evm_message",
          authorization: "evm_authorization",
        }[req.kind],
      );
      expect(Object.keys(signRequestPayload(req))).toEqual([req.kind]);
    });
  }

  it("ignores bodies that are not sign requests", () => {
    expect(parseSignRequest("plain text")).toBeUndefined();
    expect(parseSignRequest(JSON.stringify({ accepts: [] }))).toBeUndefined();
    expect(
      parseSignRequest(JSON.stringify({ sign_request: { kind: "digest", digest: "0x12" } })),
    ).toBeUndefined();
    expect(
      parseSignRequest(
        JSON.stringify({
          sign_request: { kind: "digest", digest: `0x${"ab".repeat(32)}`, submit_url: 1 },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseSignRequest(
        JSON.stringify({
          sign_request: {
            kind: "authorization",
            authorization: { chainId: -1, address: DELEGATE, nonce: 0 },
            submit_url: SUBMIT,
          },
        }),
      ),
    ).toBeUndefined();
  });
});
