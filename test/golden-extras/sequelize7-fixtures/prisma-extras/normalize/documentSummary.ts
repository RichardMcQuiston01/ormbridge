import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'document_summary',
  schema: 'audit',
  timestamps: true,
  underscored: true,
})
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

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
