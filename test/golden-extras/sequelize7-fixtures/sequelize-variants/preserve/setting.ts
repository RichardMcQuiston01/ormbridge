import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'settings',
  timestamps: false,
  indexes: [
    { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
  ],
})
export class Setting extends Model<
  InferAttributes<Setting>,
  InferCreationAttributes<Setting>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(30))
  declare scope: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(30))
  declare key: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare value: CreationOptional<string | null>;
}
