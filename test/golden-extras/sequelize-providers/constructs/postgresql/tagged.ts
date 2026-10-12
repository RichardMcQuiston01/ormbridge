import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Book } from './book.js';

export class Tagged extends Model<
  InferAttributes<Tagged>,
  InferCreationAttributes<Tagged>
> {
  declare id: CreationOptional<string>;

  declare books?: NonAttribute<Book[]>;

  static initModel(sequelize: Sequelize): typeof Tagged {
    Tagged.init(
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      },
      { sequelize, modelName: 'Tagged', tableName: 'tagged', timestamps: false }
    );
    return Tagged;
  }
}
