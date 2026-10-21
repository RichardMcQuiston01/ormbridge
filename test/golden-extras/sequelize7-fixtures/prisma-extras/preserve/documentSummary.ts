import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'DocumentSummary', schema: 'audit', timestamps: false })
export class DocumentSummary extends Model<
  InferAttributes<DocumentSummary>,
  InferCreationAttributes<DocumentSummary>
> {
  @Attribute(DataTypes.STRING)
  @PrimaryKey
  @Unique
  declare id: string;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare title: string;
}
