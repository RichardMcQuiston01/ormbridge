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
  BelongsTo,
  CreatedAt,
  Default,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Series } from './series.js';

@Table({ tableName: 'index', timestamps: true, underscored: true })
export class Index extends Model<
  InferAttributes<Index>,
  InferCreationAttributes<Index>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  declare sql: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare class: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare table: CreationOptional<string | null>;

  @BelongsTo(() => Series, {
    foreignKey: { name: 'table', onDelete: 'NO ACTION' },
  })
  declare table2?: NonAttribute<Series>;
}
