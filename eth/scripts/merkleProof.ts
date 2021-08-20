import { MerkleTree } from 'merkletreejs'
import keccak256 from 'keccak256'

interface Proofs {
  [index: string]: string[]
}

interface ProofInfo {
  root: string
  proofs: Proofs
}

export function merkleRootAndProofs (
  leaves: string[]
): ProofInfo {
  const merkleTree = new MerkleTree(
    leaves,
    keccak256,
    { hashLeaves: true, sortPairs: true }
  )
  const root = merkleTree.getHexRoot()
  let proofs: Proofs = {}
  leaves.forEach((leaf: string) => {
    const proof: Proofs = {}
    proof[leaf] = merkleTree.getHexProof(keccak256(leaf))
    proofs = { ...proofs, ...proof }
  })
  return { root, proofs }
}
