import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Other } from './other.js';

export class Weird extends Model<
  InferAttributes<Weird>,
  InferCreationAttributes<Weird>
> {
  declare id: CreationOptional<string>;
  declare aB: CreationOptional<string>;
  declare quote: CreationOptional<string>;
  declare tick: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare selfId: CreationOptional<string | null>;
  declare otherId: string;

  declare self?: NonAttribute<Weird>;
  declare other?: NonAttribute<Other>;

  static initModel(sequelize: Sequelize): typeof Weird {
    Weird.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        aB: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'x;y' },
        quote: {
          type: DataTypes.TEXT,
          allowNull: false,
          defaultValue: 'say "hi"',
        },
        tick: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'a`b' },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        selfId: DataTypes.UUID,
        otherId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Weird',
        tableName: 'weird',
        timestamps: true,
        underscored: true,
      }
    );
    return Weird;
  }
}
