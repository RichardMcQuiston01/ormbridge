import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'setting',
  timestamps: true,
  underscored: true,
  indexes: [
    { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
  ],
})
export class Setting extends Model<
  InferAttributes<Setting>,
  InferCreationAttributes<Setting>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(30))
  declare scope: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(30))
  declare key: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare value: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
