#pragma once

#include "esphome/core/component.h"
#include "esphome/components/i2c/i2c.h"

namespace esphome {
namespace wewe_axp192 {

/*
 * Minimal AXP192 power-on init for the Core2's own display/touch rails —
 * only the M5Stack Core2 sequence, hand-written from the AXP192's
 * published register map (not vendored from any third-party component;
 * martydingo/esphome-axp192 was evaluated first but is Arduino-only
 * (#include <Esp.h>, incompatible with this project's esp-idf framework)
 * and carries no declared license to vendor a patched copy of anyway).
 *
 * Must run before display:/touchscreen: try to use their rails — see
 * get_setup_priority().
 */
class WeweAxp192 : public Component, public i2c::I2CDevice {
 public:
  void setup() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::HARDWARE; }

  // Core2's backlight is wired to the AXP192's DCDC3 rail (register 0x12,
  // bit 1) — confirmed against M5Stack's own AXP192.cpp (SetDCDC3()/the
  // "Turn LCD backlight off" comment above its use in PrepareToSleep()),
  // not guessed from the general AXP192 datasheet, since register 0x12's
  // bit layout is otherwise easy to get wrong (see setup()'s LDO3 note —
  // that was a real, reproduced bug from an earlier guess).
  void set_backlight(bool on);

  // 0-100, from the same linear voltage approximation M5Stack's own
  // AXP192::GetBatteryLevel() uses (battery voltage register 0x78/0x79,
  // 1.1mV/LSB) — not a real discharge-curve model, but it's what M5Stack
  // calibrated against this exact battery/PMIC pairing.
  int get_battery_percent();
  bool is_charging();

  // Register 0x01 bit 5 — confirmed against the AXP192 datasheet's power
  // status register, NOT against M5Stack's own GetBatState(): theirs reads
  // `Read8bit(0x01) | 0x20`, a bitwise-OR against a nonzero constant that
  // is always truthy regardless of the register's actual value (a real bug
  // in their upstream code — always reports battery-present). Ours uses
  // `&`, matching what the bit is documented to mean. This board runs a
  // real M5Core2 without a battery installed, so getting this wrong is
  // exactly what put a plausible-looking "0%" on screen for a device that
  // was on USB power the whole time with nothing to read.
  bool has_battery();

 protected:
  float get_battery_voltage_();
};

}  // namespace wewe_axp192
}  // namespace esphome
