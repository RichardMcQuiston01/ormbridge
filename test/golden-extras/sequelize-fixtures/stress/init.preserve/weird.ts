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
  declare id: CreationOptional<number>;
  declare a_b: CreationOptional<string>;
  declare quote: CreationOptional<string>;
  declare tick: CreationOptional<string>;
  declare self_id: CreationOptional<number | null>;
  declare other_id: number;

  declare self?: NonAttribute<Weird>;
  declare other?: NonAttribute<Other>;

  static initModel(sequelize: Sequelize): typeof Weird {
    Weird.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        a_b: {
          type: DataTypes.TEXT,
          allowNull: false,
          defaultValue: 'x;y',
          field: 'a;b',
        },
        quote: {
          type: DataTypes.TEXT,
          allowNull: false,
          defaultValue: 'say "hi"',
        },
        tick: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'a`b' },
        self_id: DataTypes.INTEGER,
        other_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      { sequelize, modelName: 'Weird', tableName: 'weird', timestamps: false }
    );
    return Weird;
  }
}
