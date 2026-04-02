interface ApprovalBarProps {
  onApprove: () => void
  onReject: () => void
}

export function ApprovalBar({ onApprove, onReject }: ApprovalBarProps) {
  return (
    <div className="flex items-center gap-2 mt-2 p-3 bg-yellow-950/30 border border-yellow-900/50 rounded-lg">
      <span className="text-sm text-yellow-300 flex-1">
        Review the plan above and approve to proceed with implementation.
      </span>
      <button
        onClick={onReject}
        className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-sm font-medium transition-colors"
      >
        Reject
      </button>
      <button
        onClick={onApprove}
        className="px-4 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm font-medium transition-colors"
      >
        Approve
      </button>
    </div>
  )
}
