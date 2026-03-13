"""add_dataset_model_tables

Revision ID: 8c62e7348ffc
Revises: 5b4c86e787be
Create Date: 2025-12-16 17:38:55.486493

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8c62e7348ffc'
down_revision = '5b4c86e787be'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create dataset_models table
    op.create_table(
        'dataset_models',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_models_id'), 'dataset_models', ['id'], unique=False)
    op.create_index(op.f('ix_dataset_models_name'), 'dataset_models', ['name'], unique=False)

    # Create dataset_tables table
    op.create_table(
        'dataset_tables',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_model_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('role', sa.Enum('fact', 'dim', name='tablerole'), nullable=False),
        sa.Column('data_source_id', sa.Integer(), nullable=False),
        sa.Column('base_sql', sa.Text(), nullable=False),
        sa.Column('transformations', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('columns', sa.JSON(), nullable=True, server_default='[]'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['data_source_id'], ['data_sources.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['dataset_model_id'], ['dataset_models.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_tables_data_source_id'), 'dataset_tables', ['data_source_id'], unique=False)
    op.create_index(op.f('ix_dataset_tables_dataset_model_id'), 'dataset_tables', ['dataset_model_id'], unique=False)
    op.create_index(op.f('ix_dataset_tables_id'), 'dataset_tables', ['id'], unique=False)

    # Create dataset_relationships table
    op.create_table(
        'dataset_relationships',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_model_id', sa.Integer(), nullable=False),
        sa.Column('left_table_id', sa.Integer(), nullable=False),
        sa.Column('right_table_id', sa.Integer(), nullable=False),
        sa.Column('join_type', sa.Enum('left', 'inner', name='jointype'), nullable=False),
        sa.Column('on', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['dataset_model_id'], ['dataset_models.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['left_table_id'], ['dataset_tables.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['right_table_id'], ['dataset_tables.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_relationships_dataset_model_id'), 'dataset_relationships', ['dataset_model_id'], unique=False)
    op.create_index(op.f('ix_dataset_relationships_id'), 'dataset_relationships', ['id'], unique=False)

    # Create dataset_calculated_columns table
    op.create_table(
        'dataset_calculated_columns',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_model_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('expression', sa.Text(), nullable=False),
        sa.Column('data_type', sa.String(length=50), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['dataset_model_id'], ['dataset_models.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_calculated_columns_dataset_model_id'), 'dataset_calculated_columns', ['dataset_model_id'], unique=False)
    op.create_index(op.f('ix_dataset_calculated_columns_id'), 'dataset_calculated_columns', ['id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_dataset_calculated_columns_id'), table_name='dataset_calculated_columns')
    op.drop_index(op.f('ix_dataset_calculated_columns_dataset_model_id'), table_name='dataset_calculated_columns')
    op.drop_table('dataset_calculated_columns')
    
    op.drop_index(op.f('ix_dataset_relationships_id'), table_name='dataset_relationships')
    op.drop_index(op.f('ix_dataset_relationships_dataset_model_id'), table_name='dataset_relationships')
    op.drop_table('dataset_relationships')
    
    op.drop_index(op.f('ix_dataset_tables_id'), table_name='dataset_tables')
    op.drop_index(op.f('ix_dataset_tables_dataset_model_id'), table_name='dataset_tables')
    op.drop_index(op.f('ix_dataset_tables_data_source_id'), table_name='dataset_tables')
    op.drop_table('dataset_tables')
    
    op.drop_index(op.f('ix_dataset_models_name'), table_name='dataset_models')
    op.drop_index(op.f('ix_dataset_models_id'), table_name='dataset_models')
    op.drop_table('dataset_models')
    
    # Drop enums
    sa.Enum(name='jointype').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='tablerole').drop(op.get_bind(), checkfirst=True)
