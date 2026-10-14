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
  declare id: CreationOptional<string>;
  declare sql: CreationOptional<string | null>;
  declare class: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare table: CreationOptional<string | null>;

  declare table2?: NonAttribute<Series>;

  static initModel(sequelize: Sequelize): typeof Index {
    Index.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        sql: DataTypes.TEXT,
        class: DataTypes.TEXT,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        table: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'Index',
        tableName: 'index',
        timestamps: true,
        underscored: true,
      }
    );
    return Index;
  }
}
