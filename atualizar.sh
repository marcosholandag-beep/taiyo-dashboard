#!/bin/bash
# Coleta o Meta Ads e publica data/meta.json no GitHub Pages.
#
# Chamado todo dia as 09h pelo launchd (com.trilha.taiyo-dashboard).
# Esta e a rota provisoria: o caminho definitivo e o GitHub Actions em
# .github/workflows/update-data.yml, que so falta alguem com escopo `workflow`
# empurrar para o repositorio. Enquanto isso, depende deste Mac estar ligado.
set -u
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

set -a; . ./.env; set +a

carimbo() { date '+%d/%m/%Y %H:%M'; }
echo "===== $(carimbo) inicio ====="

if ! python3 fetch_meta.py; then
  echo "coleta falhou — nada publicado"
  exit 1
fi

git add data/meta.json
if git diff --staged --quiet; then
  echo "sem mudanca nos dados"
else
  git -c user.name="Taiyo Dashboard" -c user.email="marcos@somostrilha.com.br" \
      commit -q -m "chore: atualiza dados do Meta $(carimbo)"
  git push -q origin main && echo "publicado"
fi
echo "===== $(carimbo) fim ====="
