import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Setting extends Model<
  InferAttributes<Setting>,
  InferCreationAttributes<Setting>
> {
  declare id: CreationOptional<number>;
  declare scope: CreationOptional<string | null>;
  declare key: CreationOptional<string | null>;
  declare value: CreationOptional<string | null>;

  static initModel(sequelize: Sequelize): typeof Setting {
    Setting.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        scope: DataTypes.STRING(30),
        key: DataTypes.STRING(30),
        value: DataTypes.TEXT,
      },
      {
        sequelize,
        modelName: 'Setting',
        tableName: 'settings',
        timestamps: false,
        indexes: [
          { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
        ],
      }
    );
    return Setting;
  }
}
