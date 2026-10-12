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
  declare id: CreationOptional<string>;
  declare scope: CreationOptional<string | null>;
  declare key: CreationOptional<string | null>;
  declare value: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Setting {
    Setting.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        scope: DataTypes.STRING(30),
        key: DataTypes.STRING(30),
        value: DataTypes.TEXT,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Setting',
        tableName: 'setting',
        timestamps: true,
        underscored: true,
        indexes: [
          { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
        ],
      }
    );
    return Setting;
  }
}
