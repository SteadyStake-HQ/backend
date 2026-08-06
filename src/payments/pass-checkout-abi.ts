/**
 * The slice of StablecoinGamePassCheckout the backend needs: the `PassPaid` event the indexer scans
 * and the `buyPass` / `treasury` fragments used when building the client tx request and seeding.
 * Kept in sync with contracts/src/StablecoinGamePassCheckout.sol.
 */
export const PASS_CHECKOUT_ABI = [
  {
    type: 'event',
    name: 'PassPaid',
    inputs: [
      { name: 'purchaseId', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'paymentToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'planId', type: 'uint8', indexed: false },
      { name: 'durationSeconds', type: 'uint32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'buyPass',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId', type: 'uint8' },
      { name: 'purchaseId', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stablecoin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** Minimal ERC-20 the client needs to approve the exact pass amount before buyPass (§7.2). */
export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;
