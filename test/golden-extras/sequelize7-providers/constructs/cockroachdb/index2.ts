import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  BelongsTo,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Series } from './series.js';

@Table({ tableName: 'index_rows', timestamps: false })
export class Index extends Model<
  InferAttributes<Index>,
  InferCreationAttributes<Index>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  declare sql: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare class: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  declare table: CreationOptional<string | null>;

  @BelongsTo(() => Series, {
    foreignKey: { name: 'table', onDelete: 'NO ACTION' },
  })
  declare table2?: NonAttribute<Series>;
}
