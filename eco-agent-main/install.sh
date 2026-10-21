#!/bin/bash

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}   ECO AGENT — Installer${NC}"
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo ""

if ! command -v node &> /dev/null; then
  echo -e "${RED}  ✗ Node.js not found!${NC}"
  echo -e "  Install it at: ${CYAN}https://nodejs.org${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}  ✗ Node.js v18+ required. You have: $(node -v)${NC}"
  echo -e "  Update at: ${CYAN}https://nodejs.org${NC}"
  exit 1
fi

echo -e "  ${GREEN}✓${NC} Node.js $(node -v) found"

if ! command -v npm &> /dev/null; then
  echo -e "${RED}  ✗ npm not found!${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm -v) found"
echo ""

echo -e "  ${CYAN}▸${NC} Installing dependencies..."
npm install --silent
if [ $? -ne 0 ]; then
  echo -e "${RED}  ✗ npm install failed!${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo -e "  ${CYAN}▸${NC} Building..."
npm run build --silent
if [ $? -ne 0 ]; then
  echo -e "${RED}  ✗ Build failed!${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Build complete"

echo -e "  ${CYAN}▸${NC} Installing 'eco' command globally..."
if npm install -g . --silent; then
  :
else
  # SECURITY / best practice: running `sudo npm install` executes arbitrary
  # postinstall scripts with root rights. Prefer a user-owned prefix instead;
  # only suggest sudo as a manual last resort.
  echo -e "${YELLOW}  ! Global install failed (permission denied).${NC}"
  echo -e "  Recommended: install to a user prefix and add it to PATH"
  echo -e "    ${CYAN}mkdir -p ~/.npm-global${NC}"
  echo -e "    ${CYAN}npm config set prefix ~/.npm-global${NC}"
  echo -e "    ${CYAN}npm install -g .${NC}"
  echo -e "    ${CYAN}echo 'export PATH=\$HOME/.npm-global/bin:\$PATH' >> ~/.bashrc${NC}"
  echo ""
  echo -e "  Or retry this installer with sudo (runs postinstall scripts as root — use only if you trust the package):"
  echo -e "    ${CYAN}sudo ./install.sh${NC}"
  exit 1
fi

echo -e "  ${GREEN}✓${NC} 'eco' command installed!"
echo ""
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo -e "${GREEN}  Eco Agent is ready!${NC}"
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo ""
echo -e "  Run with:"
echo -e "    ${CYAN}${BOLD}eco${NC}              → open Eco Agent"
echo -e "    ${CYAN}eco --resume${NC}     → resume last session"
echo -e "    ${CYAN}eco --reset${NC}      → reset configuration"
echo -e "    ${CYAN}eco --help${NC}       → show all options"
echo ""
echo -e "  To uninstall:"
echo -e "    ${CYAN}npm uninstall -g eco-agent${NC}"
echo ""
