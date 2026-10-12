import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Series } from './series.js';

export class Index extends Model<
  InferAttributes<Index>,
  InferCreationAttributes<Index>
> {
  declare id: CreationOptional<number>;
  declare sql: CreationOptional<string | null>;
  declare class: CreationOptional<string | null>;
  declare table: CreationOptional<number | null>;

  declare table2?: NonAttribute<Series>;

  static initModel(sequelize: Sequelize): typeof Index {
    Index.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        sql: DataTypes.TEXT,
        class: DataTypes.TEXT,
        table: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Index',
        tableName: 'index_rows',
        timestamps: false,
      }
    );
    return Index;
  }
}
