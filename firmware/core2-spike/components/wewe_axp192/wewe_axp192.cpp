#include "wewe_axp192.h"
#include "esphome/core/log.h"

namespace esphome {
namespace wewe_axp192 {

static const char *const TAG = "wewe_axp192";

void WeweAxp192::setup() {
  // AXP192 power-on sequence for M5Stack Core2's own rails, per the
  // chip's register map. DCDC3 (0x27) and LDO2/LDO3 (0x28) power the
  // ILI9342C display panel + backlight; LDO3 also doubles as Core2's
  // vibration motor rail — must stay OFF (confirmed on real hardware:
  // leaving its enable bit set runs the motor continuously from boot).
  this->write_byte(0x27, 0xcc);  // DCDC3 voltage (display panel + backlight)
  this->write_byte(0x28, 0xcc);  // LDO2/LDO3 voltage (display + vibration)
  this->write_byte(0x84, 0b11110010);  // ADC sample rate 200 Hz
  this->write_byte(0x82, 0xff);        // Enable all ADCs
  this->write_byte(0x33, 0xc0);        // Battery charge voltage 4.2V, current 100mA

  uint8_t exten = 0;
  this->read_byte(0x12, &exten);
  uint8_t enable_mask = (exten & 0xef) | 0x4d;
  enable_mask &= ~(1 << 3);  // Disable LDO3 (vibration motor) specifically
  this->write_byte(0x12, enable_mask);  // Enable LDO2, DCDC1, DCDC3; LDO3 stays off

  this->write_byte(0x36, 0x0c);  // 128ms power-on / 4s power-off button timing
  this->write_byte(0x91, 0xf0);  // RTC backup battery voltage 3.3V
  this->write_byte(0x90, 0x02);  // GPIO0 as LDO (RTC)
  this->write_byte(0x30, 0x80);  // Disable VBUS hold current limit
  this->write_byte(0x39, 0xfc);  // Temperature protection thresholds
  this->write_byte(0x35, 0xa2);  // Enable RTC battery charging
  this->write_byte(0x32, 0x46);  // Enable battery detection

  ESP_LOGCONFIG(TAG, "AXP192 power rails enabled for Core2 display/touch");
}

void WeweAxp192::dump_config() { ESP_LOGCONFIG(TAG, "Wewe AXP192 (Core2 power init)"); }

void WeweAxp192::set_backlight(bool on) {
  uint8_t reg = 0;
  this->read_byte(0x12, &reg);
  if (on) {
    reg |= (1 << 1);
  } else {
    reg &= ~(1 << 1);
  }
  this->write_byte(0x12, reg);
}

float WeweAxp192::get_battery_voltage_() {
  uint8_t buf[2] = {0, 0};
  if (!this->read_bytes(0x78, buf, 2)) {
    return 0.0f;
  }
  uint16_t raw = (static_cast<uint16_t>(buf[0]) << 4) + buf[1];
  return raw * 0.0011f;  // 1.1mV/LSB, same as AXP192::GetBatVoltage()
}

int WeweAxp192::get_battery_percent() {
  float voltage = this->get_battery_voltage_();
  if (voltage <= 0.0f) {
    return -1;  // read failed
  }
  // M5Stack's own linear approximation (AXP192::GetBatteryLevel) — not a
  // real LiPo discharge curve, but calibrated by them for this exact
  // battery/PMIC pairing.
  float pct = (voltage < 3.248088f) ? 0.0f : (voltage - 3.120712f) * 100.0f;
  if (pct > 100.0f) {
    pct = 100.0f;
  }
  if (pct < 0.0f) {
    pct = 0.0f;
  }
  return static_cast<int>(pct);
}

bool WeweAxp192::is_charging() {
  uint8_t status = 0;
  this->read_byte(0x00, &status);
  return (status & (1 << 2)) != 0;
}

bool WeweAxp192::has_battery() {
  uint8_t status = 0;
  this->read_byte(0x01, &status);
  return (status & (1 << 5)) != 0;
}

}  // namespace wewe_axp192
}  // namespace esphome
