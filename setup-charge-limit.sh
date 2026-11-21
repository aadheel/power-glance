#!/usr/bin/env bash
# One-time setup that lets you turn Power Glance's battery charge limit on and off without root.
# It installs a udev rule giving your primary group write access to the battery's charge-limit files.
#
#   sudo ./setup-charge-limit.sh            set it up for the user who ran sudo
#   sudo ./setup-charge-limit.sh --user NAME
#   sudo ./setup-charge-limit.sh --remove   undo
set -euo pipefail

RULE=/etc/udev/rules.d/90-power-glance-charge-limit.rules
FILES="charge_control_start_threshold charge_control_end_threshold charge_types"

usage() {
    echo "Usage: sudo $0 [--user NAME] [--remove]"
}

user="${SUDO_USER:-}"
remove=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --user)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            user="$2"
            shift 2
            ;;
        --user=*) user="${1#--user=}"; shift ;;
        --remove) remove=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "This needs root. Run it as: sudo $0" >&2
    exit 1
fi

shopt -s nullglob
batteries=(/sys/class/power_supply/BAT*)

# Re-read the rules and replay a "change" event for every power supply, so the rule runs now
# instead of at the next restart.
apply_now() {
    udevadm control --reload-rules
    udevadm trigger --subsystem-match=power_supply --action=change
    udevadm settle --timeout=10 || true
}

if [[ $remove -eq 1 ]]; then
    if [[ -e $RULE ]]; then
        rm -f "$RULE"
        echo "Removed $RULE."
    else
        echo "No rule to remove ($RULE isn't there)."
    fi
    apply_now
    # The rule is gone, but the files keep their permissions until restart; put them back now.
    reset=1
    for bat in "${batteries[@]}"; do
        for name in $FILES; do
            [[ -e $bat/$name ]] || continue
            if ! { chgrp root "$bat/$name" && chmod g-w "$bat/$name"; }; then
                reset=0
            fi
        done
    done
    if [[ $reset -eq 1 ]]; then
        echo "The charge-limit files are writable by root only again."
    else
        echo "Some charge-limit files kept their permissions; they go back to root-only at the next restart."
    fi
    exit 0
fi

if [[ -z $user || $user == root ]]; then
    echo "Couldn't tell which user to set this up for. Run it with sudo from your own account, or add --user NAME." >&2
    exit 1
fi
if ! group="$(id -gn -- "$user" 2>/dev/null)"; then
    echo "There is no user called \"$user\"." >&2
    exit 1
fi
if [[ ! $group =~ ^[A-Za-z0-9._][A-Za-z0-9._-]*$ ]]; then
    echo "The group name \"$group\" has characters this script won't put in a udev rule." >&2
    exit 1
fi

# Check the laptop supports a charge limit, and that its firmware lets Linux read it.
supported=0
readable=0
for bat in "${batteries[@]}"; do
    [[ -e $bat/charge_control_end_threshold ]] || continue
    supported=1
    if cat "$bat/charge_control_end_threshold" >/dev/null 2>&1; then
        readable=1
    fi
done

if [[ $supported -eq 0 ]]; then
    echo "This laptop doesn't offer a charge limit to Linux, so there is nothing to set up."
    echo "Nothing was changed."
    exit 0
fi

if [[ $readable -eq 0 ]]; then
    echo "This laptop has charge-limit files, but its firmware answers every read with an error,"
    echo "even for root, so Linux can't use them. Making them writable wouldn't help."
    vendor="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)"
    if [[ $vendor == Dell* ]]; then
        echo "You can set the limit in the BIOS setup instead: press F2 at power-on, open"
        echo "Battery Charge Configuration, then choose Custom (for example 50-80%) or Primarily AC use."
    else
        echo "Your BIOS/UEFI setup may offer a charge limit; look for a battery or power section."
    fi
    echo "Nothing was changed."
    exit 0
fi

# udev turns $$ into $; the snippet skips files this battery doesn't have.
rule="# Installed by Power Glance (setup-charge-limit.sh): lets group \"$group\" change the battery charge limit.
# Undo with: sudo ./setup-charge-limit.sh --remove
SUBSYSTEM==\"power_supply\", KERNEL==\"BAT*\", ACTION==\"add|change\", RUN+=\"/bin/sh -c 'cd %S\$\$DEVPATH || exit 0; for f in $FILES; do [ -e \$\$f ] || continue; /bin/chgrp $group \$\$f; /bin/chmod g+w \$\$f; done'\""

if [[ -e $RULE && "$(cat "$RULE")" == "$rule" ]]; then
    echo "The rule is already installed ($RULE)."
else
    printf '%s\n' "$rule" >"$RULE"
    chmod 0644 "$RULE"
    echo "Installed $RULE, giving group \"$group\" (user $user) write access to the charge limit."
fi

apply_now
echo "Reloaded the udev rules and applied them to the batteries now."

ok=1
for bat in "${batteries[@]}"; do
    f="$bat/charge_control_end_threshold"
    [[ -e $f ]] || continue
    if [[ "$(stat -c %G "$f")" != "$group" ]] || (((8#$(stat -c %a "$f") & 8#020) == 0)); then
        ok=0
        echo "Warning: $f didn't pick up the new permissions yet. They will apply after a restart." >&2
    fi
done
if [[ $ok -eq 1 ]]; then
    echo "Done. The charge-limit switch in Power Glance's Battery tab works now; no restart needed."
fi
