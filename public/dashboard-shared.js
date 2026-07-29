const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function shortenAddress(address) {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function addressElement(address, explorerUrl) {
  if (!address) {
    return '<span class="addr zero">not deployed</span>';
  }
  if (address === ZERO_ADDRESS) {
    return '<span class="addr zero" title="' + address + '">— (zero address)</span>';
  }

  const label = shortenAddress(address);
  const value = explorerUrl
    ? '<a class="addr" href="' + explorerUrl + "/address/" + address +
      '" target="_blank" rel="noopener" title="' + address + '">' + label + "</a>"
    : '<span class="addr" title="' + address + '">' + label + "</span>";

  return '<span class="val">' + value +
    '<button class="copy" data-copy="' + address + '" title="Copy address" aria-label="Copy address">⧉</button></span>';
}

// Quotes are escaped too: most callers put the result in an attribute, and some of that text is
// chosen by whoever deployed the token (a plan's target-token symbol), not by an operator.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

document.addEventListener("click", function (event) {
  const copyButton = event.target.closest(".copy");
  if (!copyButton) return;

  navigator.clipboard.writeText(copyButton.dataset.copy).then(function () {
    const previous = copyButton.textContent;
    copyButton.textContent = "✓";
    window.setTimeout(function () {
      copyButton.textContent = previous;
    }, 1000);
  });
});
