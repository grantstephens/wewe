import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import i2c
from esphome.const import CONF_ID

CODEOWNERS = ["@wewe-project"]
DEPENDENCIES = ["i2c"]

wewe_axp192_ns = cg.esphome_ns.namespace("wewe_axp192")
WeweAxp192 = wewe_axp192_ns.class_("WeweAxp192", cg.Component, i2c.I2CDevice)

CONFIG_SCHEMA = (
    cv.Schema({cv.GenerateID(): cv.declare_id(WeweAxp192)})
    .extend(cv.COMPONENT_SCHEMA)
    .extend(i2c.i2c_device_schema(0x34))
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await i2c.register_i2c_device(var, config)
